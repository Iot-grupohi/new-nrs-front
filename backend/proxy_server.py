
from flask import Flask, request, jsonify
import requests
import logging
import time
import subprocess
import os
import sys
import json
from pathlib import Path
import atexit
import signal
import re
import threading
import shutil
from datetime import datetime
import psutil
import socket
from colorama import init, Fore, Back, Style
from concurrent.futures import ThreadPoolExecutor

from lav60_env import load_local_env

# Variáveis que o agente lê obrigatoriamente do Windows (registro User/Machine).
AGENT_WINDOWS_ENV_KEYS = (
    'STORE_ID',
    'TUNNEL_NAME',
    'API_TOKEN',
    'LAV60_API_TOKEN',
    'LAV60_MACHINES_API_TOKEN',
    'MACHINES_API_TOKEN',
    'PANEL_HEARTBEAT_URL',
    'PANEL_HOST',
    'PANEL_PORT',
)

# Painel: registro Windows tem prioridade; se vazio, usa .env (não cai no IP LAN padrão).
AGENT_WINDOWS_PANEL_ENV_KEYS = frozenset({
    'PANEL_HEARTBEAT_URL',
    'PANEL_HOST',
    'PANEL_PORT',
})

# Se vazio no registro Windows, mantém valor do .env embutido ou ao lado do .exe.
AGENT_WINDOWS_ENV_FALLBACK_KEYS = frozenset({
    'API_TOKEN',
    'LAV60_API_TOKEN',
    'LAV60_MACHINES_API_TOKEN',
    'MACHINES_API_TOKEN',
    *AGENT_WINDOWS_PANEL_ENV_KEYS,
})


def _read_windows_registry_env(name: str) -> str:
    """Lê variável User/Machine do registro Windows (quando o processo não herdou)."""
    if os.name != 'nt':
        return ''
    try:
        import winreg
    except ImportError:
        return ''

    def _read_hive(hive, subkey: str) -> str:
        try:
            with winreg.OpenKey(hive, subkey) as key:
                val, _ = winreg.QueryValueEx(key, name)
                return str(val).strip() if val is not None else ''
        except OSError:
            return ''

    user_val = _read_hive(winreg.HKEY_CURRENT_USER, r'Environment')
    if user_val:
        return user_val
    return _read_hive(
        winreg.HKEY_LOCAL_MACHINE,
        r'SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
    )


def _windows_env(name: str) -> str:
    """Variável do agente: no Windows, registro (User → Machine) tem prioridade."""
    if os.name == 'nt':
        reg_val = _read_windows_registry_env(name)
        if reg_val:
            return reg_val
        if name in AGENT_WINDOWS_ENV_FALLBACK_KEYS:
            return (os.environ.get(name) or '').strip()
        if name in AGENT_WINDOWS_ENV_KEYS:
            return ''
    return (os.environ.get(name) or '').strip()


def apply_windows_registry_env() -> None:
    """Sincroniza variáveis do agente a partir do registro Windows."""
    if os.name != 'nt':
        return
    for key in AGENT_WINDOWS_ENV_KEYS:
        value = _read_windows_registry_env(key)
        if value:
            os.environ[key] = value
        elif key not in AGENT_WINDOWS_ENV_FALLBACK_KEYS:
            os.environ.pop(key, None)


load_local_env()
_ENV_FILE_API_TOKEN = (os.environ.get('API_TOKEN') or '').strip()
apply_windows_registry_env()

app = Flask(__name__)


def _example_store_slug() -> str:
    try:
        return require_store_id().lower()
    except RuntimeError:
        return '{store_id}'


CORS_ORIGIN = os.getenv('CORS_ORIGIN', '*')


@app.before_request
def handle_cors_preflight():
    if request.method == 'OPTIONS':
        response = app.make_response(('', 204))
        origin = request.headers.get('Origin', '*')
        response.headers['Access-Control-Allow-Origin'] = CORS_ORIGIN if CORS_ORIGIN != '*' else origin
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Token, Accept'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        return response


@app.after_request
def add_cors_headers(response):
    if CORS_ORIGIN:
        origin = request.headers.get('Origin')
        if CORS_ORIGIN == '*' or (origin and origin in CORS_ORIGIN.split(',')):
            response.headers['Access-Control-Allow-Origin'] = origin or CORS_ORIGIN
        elif CORS_ORIGIN == '*':
            response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Token, Accept'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return response


@app.errorhandler(405)
def api_method_not_allowed(e):
    if request.path.startswith('/api/'):
        host = request.host.split(':')[0]
        allowed = sorted(getattr(e, 'valid_methods', None) or ['GET', 'POST'])
        return jsonify({
            'error': 'Method Not Allowed',
            'method': request.method,
            'path': request.path,
            'allowed_methods': allowed,
            'hint': 'Use HTTPS — requisições http:// são redirecionadas e POST pode virar GET',
            'example': {
                'method': 'POST',
                'url': f'https://{host}/{_example_store_slug()}/washer/321',
                'headers': {'Content-Type': 'application/json', 'X-Token': '...'},
                'body': {},
            },
        }), 405
    return e

# Inicializar colorama para Windows
init(autoreset=True)


def is_frozen() -> bool:
    return bool(getattr(sys, 'frozen', False))


def runtime_dir() -> Path:
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def config_dir() -> Path:
    return project_root() / 'config'


def app_data_dir() -> Path:
    """Dados graváveis do agente (config, logs) — não exige arquivos ao lado do .exe."""
    d = Path.home() / '.lav60'
    d.mkdir(parents=True, exist_ok=True)
    return d


def log_file_path() -> Path:
    return app_data_dir() / 'lav60_gateway.log'


def cloudflared_log_path() -> Path:
    return app_data_dir() / 'cloudflared.log'


def pause_before_exit(message: str = '') -> None:
    """Mantém o console aberto após erro no executável."""
    if not is_frozen() and os.environ.get('LAV60_PAUSE_ON_EXIT', '').strip().lower() not in ('1', 'true', 'yes'):
        return
    try:
        if message:
            print(message, file=sys.stderr)
        print(f'Log: {log_file_path()}', file=sys.stderr)
        input('\nPressione Enter para fechar...')
    except (EOFError, KeyboardInterrupt):
        pass

# Thread pool para processamento assíncrono
thread_executor = ThreadPoolExecutor(max_workers=10, thread_name_prefix="async_worker")

# Variáveis de monitoramento do túnel
tunnel_monitoring = True
network_monitoring = True
last_network_status: dict = {}
network_status_lock = threading.Lock()
store_machines_catalog: dict | None = None
store_machines_lock = threading.Lock()
store_machines_last_refresh: float = 0.0
tunnel_health_check_interval = 120  # segundos (aumentado para 2 minutos)
last_tunnel_check = 0
tunnel_connection_failures = 0
max_tunnel_failures = int(os.getenv('TUNNEL_MAX_FAILURES', '10'))
max_tunnel_failures_critical = int(os.getenv('TUNNEL_MAX_FAILURES_CRITICAL', '3'))
last_subdomain_status_code: int | None = None
last_inbound_request_at: float | None = None
last_inbound_client_ip: str | None = None
# Códigos HTTP do Cloudflare que indicam túnel/origem indisponível (ex.: 530)
TUNNEL_CRITICAL_HTTP_CODES = frozenset({502, 503, 521, 522, 523, 524, 525, 526, 530})

# IP base da rede (configurável via variável de ambiente)
NETWORK_BASE_IP = os.getenv('NETWORK_BASE_IP', '192.168.50')
TARGET_SERVER = f"http://{NETWORK_BASE_IP}.XXX/lb"
DOMAIN_SUFFIX = os.getenv('DOMAIN_SUFFIX', 'powpay.com.br')

PING_COUNT = int(os.getenv('PING_COUNT', '2'))
PING_TIMEOUT = int(os.getenv('PING_TIMEOUT', '4'))
# Offline só após falhar 3 consultas (1 inicial + 2 confirmações)
PING_RETRIES = int(os.getenv('PING_RETRIES', '3'))
PING_RETRY_DELAY = float(os.getenv('PING_RETRY_DELAY', '0.5'))
DOSER_HTTP_TIMEOUT = int(os.getenv('DOSER_HTTP_TIMEOUT', '4'))
NETWORK_CHECK_INTERVAL = int(os.getenv('NETWORK_CHECK_INTERVAL', '60'))
HEARTBEAT_INTERVAL = int(os.getenv('HEARTBEAT_INTERVAL', '15'))
MACHINES_CATALOG_REFRESH_INTERVAL = int(os.getenv('MACHINES_CATALOG_REFRESH_INTERVAL', '15'))

MACHINES_API_URL = os.getenv(
    'LAV60_MACHINES_API_URL',
    'https://sistema.lavanderia60minutos.com.br/api/v1/machines',
).strip()

MACHINE_CAPACITY_LABELS = {
    'normal_capacity': 'giant',
    'large_capacity': 'titan',
}
MACHINE_STATUS_LABELS = {
    'available': 'Disponível',
    'occupied': 'Ocupada',
    'busy': 'Ocupada',
    'suspended': 'Suspensa',
}
MACHINE_TYPE_LABELS = {
    'washer': 'Lavadora',
    'dryer': 'Secadora',
    'doser': 'Dosadora',
    'ac': 'Ar-condicionado',
}

VALID_SOFTENERS = ['FLORAL', 'SPORT', 'SEM_AMACIANTE', 'DISABLE']
VALID_DOSAGES = ['SIMPLES', 'DUPLA']
DRYER_TIMER_RELEASES = {15: 1, 30: 2, 45: 3}
DOSADORA_DOSAGE_ENDPOINTS = {
    ('FLORAL', 'SIMPLES'): '/am01-1',
    ('FLORAL', 'DUPLA'): '/am01-2',
    ('SPORT', 'SIMPLES'): '/am02-1',
    ('SPORT', 'DUPLA'): '/am02-2',
}
DOSADORA_SEM_CHEIRO_ENDPOINT = '/softener0'
DOSADORA_RELAY_ENDPOINTS = {
    'SABAO': '/rele1on',
    'FLORAL': '/rele2on',
    'SPORT': '/rele3on',
}
DOSADORA_RELAY_ALIASES = {
    'sabao': 'SABAO', 'sabão': 'SABAO', 'soap': 'SABAO', 'rele1': 'SABAO', 'rele1on': 'SABAO', '1': 'SABAO',
    'floral': 'FLORAL', 'rele2': 'FLORAL', 'rele2on': 'FLORAL', '2': 'FLORAL',
    'sport': 'SPORT', 'rele3': 'SPORT', 'rele3on': 'SPORT', '3': 'SPORT',
}

API_TOKEN = _windows_env('API_TOKEN') or (os.getenv('API_TOKEN') if os.name != 'nt' else '')
VALID_WASHER_AM = ('am01-1', 'am01-2', 'am02-1', 'am02-2')
AC_TEMPERATURES = ('18', '22', 'off')
AC_DEVICE_PATHS = {'18': '/airon1', '22': '/airon2', 'off': '/airon3'}
DOSER_TYPE_PATHS = {
    'softener0': '/softener0', 'softener1': '/softener1', 'softener2': '/softener2', 'softener3': '/softener3',
    'am01-1': '/am01-1', 'am01-2': '/am01-2', 'am02-1': '/am02-1', 'am02-2': '/am02-2',
    'rele1on': '/rele1on', 'rele2on': '/rele2on', 'rele3on': '/rele3on',
    'consultasb01': '/consultasb01', 'consultaam01': '/consultaam01', 'consultaam02': '/consultaam02',
    'eepromread': '/eepromread', 'status': '/status',
}
AMACIANTE_NUMBER_PATHS = {1: '/softener1', 2: '/softener2', 3: '/softener3'}
GATEWAY_PUBLIC_PATHS = {'/', '/health', '/api/health', '/api/agent/config'}
SKIP_ACCESS_LOG_PATHS = frozenset({'/health', '/api/health'})
GATEWAY_OPERATION_ACTIONS = frozenset({'washer', 'dryer', 'doser', 'ac', 'led'})
LOGGER_NAME = 'lav60.gateway'
GATEWAY_STORE_ROUTE_ACTIONS = frozenset({'washer', 'dryer', 'doser', 'ac', 'status', 'led', 'devices'})


def _resolve_machines_api_token() -> str:
    for name in ('LAV60_API_TOKEN', 'LAV60_MACHINES_API_TOKEN', 'MACHINES_API_TOKEN'):
        value = (_windows_env(name) or '').strip()
        if value:
            return value
    return ''


MACHINES_API_TOKEN = _resolve_machines_api_token()


def _read_panel_url_file() -> str:
    """panel_url.txt — URL do painel central (PC do monitoramento)."""
    candidates = []
    if is_frozen():
        candidates.append(Path(sys.executable).resolve().parent / 'panel_url.txt')
    candidates.append(app_data_dir() / 'panel_url.txt')
    candidates.append(Path.cwd() / 'panel_url.txt')
    for path in candidates:
        try:
            if not path.is_file():
                continue
            raw = path.read_text(encoding='utf-8').strip()
            if not raw:
                continue
            if raw.startswith('http'):
                base = raw.rstrip('/')
                return base if base.endswith('/api/heartbeat') else f'{base}/api/heartbeat'
            if ':' in raw and not raw.startswith('['):
                return f'http://{raw}/api/heartbeat'
            return f'http://{raw}:3000/api/heartbeat'
        except OSError:
            continue
    return ''


def _normalize_panel_heartbeat_url(url: str) -> str:
    base = url.strip().rstrip('/')
    if not base:
        return ''
    return base if base.endswith('/api/heartbeat') else f'{base}/api/heartbeat'


def _resolve_panel_heartbeat_url() -> str:
    explicit = _normalize_panel_heartbeat_url(_windows_env('PANEL_HEARTBEAT_URL'))
    if explicit:
        return explicit
    from_file = _read_panel_url_file()
    if from_file:
        return from_file
    panel_host = _windows_env('PANEL_HOST')
    if panel_host:
        if panel_host.startswith('http'):
            return _normalize_panel_heartbeat_url(panel_host)
        return f'https://{panel_host.rstrip("/")}/api/heartbeat'
    lan_host = (
        os.getenv('PANEL_LAN_HOST')
        or _windows_env('PANEL_LAN_HOST')
        or os.getenv('DEFAULT_PANEL_LAN_HOST', '192.168.50.248')
    ).strip()
    lan_port = (
        _windows_env('PANEL_PORT')
        or os.getenv('DEFAULT_PANEL_PORT', '3000')
    ).strip()
    if lan_host:
        return f'http://{lan_host}:{lan_port}/api/heartbeat'
    return f'https://panel.{DOMAIN_SUFFIX}/api/heartbeat'


PANEL_HEARTBEAT_TRY_TIMEOUT = int(os.getenv('PANEL_HEARTBEAT_TRY_TIMEOUT', '4'))
_cached_working_panel_url: str | None = None
panel_heartbeat_enabled = True


def get_panel_heartbeat_url_candidates() -> list[str]:
    """URLs do painel, em ordem de tentativa (memoriza a que funcionou)."""
    global _cached_working_panel_url
    ordered: list[str] = []
    seen: set[str] = set()

    def add(url: str) -> None:
        normalized = _normalize_panel_heartbeat_url(url)
        if normalized and normalized not in seen:
            seen.add(normalized)
            ordered.append(normalized)

    if _cached_working_panel_url:
        add(_cached_working_panel_url)
    add(_resolve_panel_heartbeat_url())
    explicit_env = (
        os.getenv('PANEL_HEARTBEAT_URL') or _windows_env('PANEL_HEARTBEAT_URL') or ''
    ).strip()
    if not explicit_env:
        add('http://127.0.0.1:3000/api/heartbeat')
        add('http://localhost:3000/api/heartbeat')
    return ordered


def get_panel_heartbeat_url() -> str:
    """URL principal do painel (primeira candidata)."""
    candidates = get_panel_heartbeat_url_candidates()
    return candidates[0] if candidates else ''


def require_store_id() -> str:
    value = _windows_env('STORE_ID')
    if value:
        return value.strip().upper()
    raise RuntimeError(
        'Defina STORE_ID nas variáveis de ambiente do Windows '
        '(Configurações → Sistema → Sobre → Configurações avançadas do sistema → '
        'Variáveis de ambiente). Reinicie o agente após alterar.'
    )


def env_store_id() -> str:
    """Código da loja — obrigatório via STORE_ID (variáveis de ambiente do Windows)."""
    return require_store_id()


def tunnel_target_name() -> str:
    tunnel = _windows_env('TUNNEL_NAME')
    if tunnel:
        return tunnel.upper()
    return require_store_id()


def store_hostname(store_id: str) -> str:
    return f"{store_id.lower()}.{DOMAIN_SUFFIX}"


# Sistema de rastreamento de resultados assíncronos
async_results = {}  # {request_id: {'status': 'processing'|'success'|'failed', 'error': str}}

def cleanup_old_async_results():
    """Remove resultados antigos do sistema de rastreamento"""
    global async_results
    current_time = time.time()
    
    # Remover resultados com mais de 5 minutos
    old_keys = []
    for request_id, result in async_results.items():
        if 'timestamp' in result and current_time - result['timestamp'] > 300:  # 5 minutos
            old_keys.append(request_id)
    
    for key in old_keys:
        del async_results[key]
    
    if old_keys:
        logger.info(f"🧹 Cleaned up {len(old_keys)} old async results")

class ColoredFormatter(logging.Formatter):
    """Formatter customizado com cores para diferentes níveis de log"""
    
    COLORS = {
        'DEBUG': Fore.CYAN,
        'INFO': Fore.GREEN,
        'WARNING': Fore.YELLOW,
        'ERROR': Fore.RED,
        'CRITICAL': Fore.RED + Back.WHITE + Style.BRIGHT,
    }
    
    def format(self, record):
        # Adicionar cor baseada no nível
        color = self.COLORS.get(record.levelname, '')
        record.levelname = f"{color}{record.levelname}{Style.RESET_ALL}"
        
        # Formatação customizada
        if hasattr(record, 'request_id'):
            record.msg = f"{Fore.BLUE}[{record.request_id}]{Style.RESET_ALL} {record.msg}"
        
        return super().format(record)


class FlushingStreamHandler(logging.StreamHandler):
    """Garante flush imediato no console (Windows + Flask dev server)."""

    def emit(self, record):
        super().emit(record)
        self.flush()


def flush_logs() -> None:
    for handler in logger.handlers:
        if hasattr(handler, 'flush'):
            handler.flush()


def setup_logging():
    """Configura o sistema de logging profissional"""
    log = logging.getLogger(LOGGER_NAME)
    log.setLevel(logging.INFO)
    log.propagate = False
    
    # Remover handlers existentes
    for handler in log.handlers[:]:
        log.removeHandler(handler)
    
    # Criar console handler
    console_handler = FlushingStreamHandler()
    console_handler.setLevel(logging.INFO)
    
    # Formatter profissional
    formatter = ColoredFormatter(
        fmt='%(asctime)s | %(levelname)-8s | %(message)s',
        datefmt='%H:%M:%S'
    )
    console_handler.setFormatter(formatter)
    log.addHandler(console_handler)

    for name in ('werkzeug', 'werkzeug.serving'):
        wlog = logging.getLogger(name)
        wlog.handlers.clear()
        wlog.addHandler(console_handler)
        wlog.setLevel(logging.INFO)
        wlog.propagate = False

    try:
        plain = logging.Formatter(
            fmt='%(asctime)s | %(levelname)-8s | %(message)s',
            datefmt='%H:%M:%S',
        )

        class _StripAnsiFilter(logging.Filter):
            _ansi = re.compile(r'\x1b\[[0-9;]*m')

            def filter(self, record):
                record.msg = self._ansi.sub('', str(record.msg))
                return True

        file_handler = logging.FileHandler(log_file_path(), encoding='utf-8')
        file_handler.setLevel(logging.INFO)
        file_handler.addFilter(_StripAnsiFilter())
        file_handler.setFormatter(plain)
        log.addHandler(file_handler)
    except Exception:
        pass
    
    return log

# Configurar logging
logger = setup_logging()


def fatal_exit(code: int, message: str) -> None:
    logger.error(message)
    print(f'\nERRO: {message}', file=sys.stderr)
    log_hint = log_file_path()
    if log_hint.exists():
        print(f'Log: {log_hint}', file=sys.stderr)
    pause_before_exit()
    raise SystemExit(code)

def log_section(title: str, level: str = "INFO"):
    """Log uma seção com formatação especial"""
    separator = "=" * 60
    if level == "INFO":
        logger.info(f"{Fore.CYAN}{separator}{Style.RESET_ALL}")
        logger.info(f"{Fore.CYAN}{title:^60}{Style.RESET_ALL}")
        logger.info(f"{Fore.CYAN}{separator}{Style.RESET_ALL}")
    elif level == "WARNING":
        logger.warning(f"{Fore.YELLOW}{separator}{Style.RESET_ALL}")
        logger.warning(f"{Fore.YELLOW}{title:^60}{Style.RESET_ALL}")
        logger.warning(f"{Fore.YELLOW}{separator}{Style.RESET_ALL}")
    elif level == "ERROR":
        logger.error(f"{Fore.RED}{separator}{Style.RESET_ALL}")
        logger.error(f"{Fore.RED}{title:^60}{Style.RESET_ALL}")
        logger.error(f"{Fore.RED}{separator}{Style.RESET_ALL}")

def request_client_ip() -> str:
    client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.environ.get('REMOTE_ADDR', 'unknown'))
    if client_ip and ',' in client_ip:
        client_ip = client_ip.split(',')[0].strip()
    return client_ip or 'unknown'


def should_skip_access_log(path: str, method: str) -> bool:
    if path in SKIP_ACCESS_LOG_PATHS:
        return True
    parts = [p for p in path.strip('/').split('/') if p]
    if len(parts) >= 2 and parts[1] in ('status', 'devices') and method == 'GET':
        return True
    return False


def is_gateway_operation(path: str, method: str) -> bool:
    if method not in ('POST', 'PUT', 'PATCH', 'DELETE'):
        return False
    parts = [p for p in path.strip('/').split('/') if p]
    return len(parts) >= 2 and parts[1] in GATEWAY_OPERATION_ACTIONS


def log_request_info(request_id: str, method: str, url: str, client_ip: str):
    """Log compacto de requisição HTTP (uma linha — visível no terminal)."""
    path = request.path if request else url.split('://', 1)[-1].split('/', 1)[-1]
    path = '/' + path if path and not path.startswith('/') else (path or '/')
    if should_skip_access_log(path, method):
        return
    if is_gateway_operation(path, method):
        logger.info(
            f"{Fore.YELLOW}⚡ {method} {path}{Style.RESET_ALL} "
            f"{Fore.CYAN}← {client_ip}{Style.RESET_ALL} "
            f"{Fore.BLUE}[{request_id}]{Style.RESET_ALL}"
        )
    else:
        logger.info(
            f"{Fore.MAGENTA}→ {method} {path}{Style.RESET_ALL} "
            f"{Fore.CYAN}← {client_ip}{Style.RESET_ALL} "
            f"{Fore.BLUE}[{request_id}]{Style.RESET_ALL}"
        )
    flush_logs()


def log_response_info(request_id: str, status_code: int, processing_time: float, response_size: int):
    """Log compacto de resposta HTTP (uma linha)."""
    path = request.path if request else ''
    method = request.method if request else ''
    if path and should_skip_access_log(path, method):
        return
    status_color = Fore.GREEN if 200 <= status_code < 300 else Fore.RED if status_code >= 400 else Fore.YELLOW
    op_prefix = f"{Fore.YELLOW}⚡{Style.RESET_ALL} " if path and is_gateway_operation(path, method) else ''
    logger.info(
        f"{op_prefix}{status_color}← {status_code}{Style.RESET_ALL} "
        f"{method} {path} ({processing_time:.3f}s, {response_size}B) "
        f"{Fore.BLUE}[{request_id}]{Style.RESET_ALL}"
    )
    flush_logs()

def log_process_info(process_name: str, action: str, pid: int = None, details: str = None):
    """Log estruturado de informações de processo"""
    logger.info(f"{Fore.CYAN}🔧 {process_name}: {action}{Style.RESET_ALL}")
    if pid:
        logger.info(f"   PID: {Fore.WHITE}{pid}{Style.RESET_ALL}")
    if details:
        logger.info(f"   Details: {Fore.WHITE}{details}{Style.RESET_ALL}")

def log_tunnel_info(status: str, connections: int = None, host: str = None):
    """Log estruturado de informações do tunnel"""
    if status == "starting":
        logger.info(f"{Fore.CYAN}🚇 Starting Cloudflare Tunnel...{Style.RESET_ALL}")
    elif status == "started":
        logger.info(f"{Fore.GREEN}✅ Cloudflare Tunnel started successfully{Style.RESET_ALL}")
    elif status == "stopping":
        logger.info(f"{Fore.YELLOW}🛑 Stopping Cloudflare Tunnel...{Style.RESET_ALL}")
    elif status == "stopped":
        logger.info(f"{Fore.RED}❌ Cloudflare Tunnel stopped{Style.RESET_ALL}")
    elif status == "status":
        status_color = Fore.GREEN if connections and connections > 0 else Fore.RED
        logger.info(f"{Fore.CYAN}📊 Tunnel Status: {status_color}{'Connected' if connections and connections > 0 else 'Disconnected'}{Style.RESET_ALL}")
        if connections is not None:
            logger.info(f"   Active Connections: {Fore.WHITE}{connections}{Style.RESET_ALL}")
        if host:
            logger.info(f"   Host: {Fore.WHITE}{host}{Style.RESET_ALL}")

def tunnel_failure_threshold() -> int:
    """Limite de falhas antes de reiniciar — mais baixo para erros críticos (ex.: HTTP 530)."""
    if last_subdomain_status_code in TUNNEL_CRITICAL_HTTP_CODES:
        return max_tunnel_failures_critical
    return max_tunnel_failures


def initiate_tunnel_restart(reason: str) -> None:
    """Reinicia só o cloudflared — mantém agente Flask, heartbeat e monitoramento de rede."""
    global tunnel_connection_failures, last_subdomain_status_code
    logger.warning(
        f"{Fore.YELLOW}🔄 Reiniciando túnel Cloudflare ({reason}) — agente permanece conectado{Style.RESET_ALL}"
    )
    tunnel_connection_failures = 0
    last_subdomain_status_code = None
    stop_cloudflared_only()
    time.sleep(2)
    start_tunnel()
    logger.info(
        f"{Fore.GREEN}✅ Túnel reiniciado — servidor local e heartbeat inalterados{Style.RESET_ALL}"
    )


def check_local_health(timeout: float = 3) -> bool:
    """Confirma que o Flask local responde (origem do túnel)."""
    try:
        resp = requests.get(f'http://127.0.0.1:{SERVER_PORT}/health', timeout=timeout)
        return resp.ok
    except Exception:
        return False


def check_tunnel_health():
    """Verifica a saúde da conexão do túnel Cloudflare"""
    global tunnel_connection_failures, last_tunnel_check, last_subdomain_status_code
    
    try:
        current_time = time.time()
        last_tunnel_check = current_time

        if not check_local_health():
            logger.warning(
                f"{Fore.YELLOW}⚠️ Agente local não responde em "
                f"http://127.0.0.1:{SERVER_PORT}/health{Style.RESET_ALL}"
            )
            tunnel_connection_failures += 1
            return False
        
        # Verificar se o processo cloudflared está rodando
        if not tunnel_process or tunnel_process.poll() is not None:
            logger.warning(f"{Fore.YELLOW}⚠️ Tunnel process not running or terminated{Style.RESET_ALL}")
            tunnel_connection_failures += 1
            return False

        tunnel_info = get_tunnel_status(os.environ.get('TUNNEL_NAME'))
        if not tunnel_info.get('has_connections'):
            logger.warning(
                f"{Fore.YELLOW}⚠️ cloudflared sem conexão ativa com Cloudflare "
                f"(observadas: {tunnel_info.get('connections_observed', 0)}) — "
                f"veja {cloudflared_log_path()}{Style.RESET_ALL}"
            )
            tunnel_connection_failures += 1
            return False
        
        try:
            store_id = env_store_id()
            subdomain_info = check_external_subdomain(store_id)

            if not subdomain_info.get('ok', False):
                status_code = subdomain_info.get('status_code')
                last_subdomain_status_code = status_code
                logger.warning(
                    f"{Fore.YELLOW}⚠️ Subdomain not responding (HTTP {status_code or 'unknown'}){Style.RESET_ALL}"
                )
                if status_code in TUNNEL_CRITICAL_HTTP_CODES:
                    logger.warning(
                        f"{Fore.YELLOW}⚠️ Critical Cloudflare error detected — "
                        f"restart after {max_tunnel_failures_critical} consecutive failure(s){Style.RESET_ALL}"
                    )
                tunnel_connection_failures += 1
                return False
            
            last_subdomain_status_code = None
            logger.info(
                f"{Fore.GREEN}✅ Tunnel is healthy: local OK, cloudflared conectado, "
                f"subdomínio OK{Style.RESET_ALL}"
            )
            tunnel_connection_failures = 0
            return True
            
        except Exception as e:
            logger.warning(f"{Fore.YELLOW}⚠️ Tunnel connectivity test failed: {str(e)}{Style.RESET_ALL}")
            tunnel_connection_failures += 1
            return False
            
    except Exception as e:
        logger.error(f"{Fore.RED}💥 Tunnel health check error: {str(e)}{Style.RESET_ALL}")
        tunnel_connection_failures += 1
        return False

def monitor_tunnel_connection():
    """Monitora a conexão do túnel em background"""
    global tunnel_monitoring, tunnel_connection_failures
    
    logger.info(f"{Fore.CYAN}🔍 Starting tunnel monitoring (interval: {tunnel_health_check_interval}s){Style.RESET_ALL}")
    
    while tunnel_monitoring:
        try:
            # Ajustar intervalo baseado no número de falhas
            if tunnel_connection_failures > 0:
                # Se há falhas, verificar mais frequentemente
                check_interval = min(30, tunnel_health_check_interval // 2)
                logger.info(f"{Fore.YELLOW}⚠️ Tunnel issues detected, checking every {check_interval}s{Style.RESET_ALL}")
            else:
                check_interval = tunnel_health_check_interval
            
            time.sleep(check_interval)
            
            if not tunnel_monitoring:
                break
                
            # Verificação robusta com logs detalhados
            is_healthy = check_tunnel_health()
            
            if not is_healthy:
                threshold = tunnel_failure_threshold()
                logger.warning(
                    f"{Fore.YELLOW}⚠️ Tunnel health check failed "
                    f"({tunnel_connection_failures}/{threshold}){Style.RESET_ALL}"
                )

                if tunnel_connection_failures >= threshold:
                    if last_subdomain_status_code in TUNNEL_CRITICAL_HTTP_CODES:
                        reason = f"HTTP {last_subdomain_status_code} on subdomain"
                    elif not tunnel_process or tunnel_process.poll() is not None:
                        reason = "cloudflared process down"
                    else:
                        reason = f"{tunnel_connection_failures} consecutive health check failures"
                    initiate_tunnel_restart(reason)
            else:
                # Log de sucesso apenas ocasionalmente para reduzir verbosidade
                if tunnel_connection_failures == 0 and int(time.time()) % 300 == 0:  # A cada 5 minutos
                    logger.info(f"{Fore.GREEN}✅ Tunnel monitoring: All systems healthy{Style.RESET_ALL}")
                
        except Exception as e:
            logger.error(f"{Fore.RED}💥 Tunnel monitoring error: {str(e)}{Style.RESET_ALL}")
            time.sleep(30)  # Aguardar mais tempo antes de tentar novamente

def restart_application():
    """Reinicia o processo Python (manual) — não mata o PID atual antes do execv."""
    logger.info(f"{Fore.YELLOW}🔄 Reiniciando agente (reinício manual)...{Style.RESET_ALL}")

    try:
        stop_cloudflared_only()
        time.sleep(1)
        logger.info(f"{Fore.YELLOW}🚀 Substituindo processo Python (execv)...{Style.RESET_ALL}")
        os.execv(sys.executable, [sys.executable] + sys.argv)

    except Exception as e:
        logger.error(f"{Fore.RED}💥 Failed to restart application: {str(e)}{Style.RESET_ALL}")
        logger.error(f"{Fore.RED}🛑 Manual restart required{Style.RESET_ALL}")
        logger.error(f"{Fore.RED}💡 Try: python backend/proxy_server.py{Style.RESET_ALL}")

def process_release_async(machine_id: str, target_url: str, release_count: int, params: dict, request_id: str, start_time: float):
    """Processa a liberação da máquina em background"""
    global async_results
    
    try:
        # Marcar como processando
        async_results[request_id] = {'status': 'processing', 'error': None, 'timestamp': time.time()}
        
        logger.info(f"[{request_id}] 🔄 Processing release in background...")
        
        # Executar as requisições para o servidor local
        logger.info(f"[{request_id}] ⚡ Executing {release_count} request(s) to target server...")
        responses = []
        failed_requests = 0
        
        for i in range(release_count):
            try:
                logger.info(f"[{request_id}] 📤 Sending request {i+1}/{release_count} to target")
                response = requests.get(target_url, params={}, timeout=15)  # Aumentar timeout
                responses.append(response)
                status_color = Fore.GREEN if response.status_code == 200 else Fore.RED
                logger.info(f"[{request_id}] ✅ Request {i+1} completed: {status_color}{response.status_code}{Style.RESET_ALL}")
                
                if response.status_code != 200:
                    failed_requests += 1
                    # Se a primeira requisição falhar, parar imediatamente
                    if i == 0:
                        error_msg = f"First request failed with status {response.status_code}"
                        async_results[request_id] = {'status': 'failed', 'error': error_msg, 'timestamp': time.time()}
                        logger.error(f"[{request_id}] 💥 First request failed, stopping immediately: {error_msg}")
                        return
                
            except requests.exceptions.Timeout:
                logger.error(f"[{request_id}] ⏰ Timeout on request {i+1} to {target_url}")
                failed_requests += 1
                # Se a primeira requisição falhar por timeout, parar imediatamente
                if i == 0:
                    error_msg = f"First request timeout to {target_url}"
                    async_results[request_id] = {'status': 'failed', 'error': error_msg, 'timestamp': time.time()}
                    logger.error(f"[{request_id}] 💥 First request timeout, stopping immediately: {error_msg}")
                    return
                
            except requests.exceptions.ConnectionError:
                logger.error(f"[{request_id}] 🔌 Connection error on request {i+1} to {target_url}")
                failed_requests += 1
                # Se a primeira requisição falhar por conexão, parar imediatamente
                if i == 0:
                    error_msg = f"First request connection error to {target_url}"
                    async_results[request_id] = {'status': 'failed', 'error': error_msg, 'timestamp': time.time()}
                    logger.error(f"[{request_id}] 💥 First request connection error, stopping immediately: {error_msg}")
                    return
                
            except Exception as e:
                logger.error(f"[{request_id}] 💥 Error on request {i+1}: {str(e)}")
                failed_requests += 1
                # Se a primeira requisição falhar por erro, parar imediatamente
                if i == 0:
                    error_msg = f"First request error: {str(e)}"
                    async_results[request_id] = {'status': 'failed', 'error': error_msg, 'timestamp': time.time()}
                    logger.error(f"[{request_id}] 💥 First request error, stopping immediately: {error_msg}")
                    return
            
            # Adicionar intervalo de 1 segundo entre requisições (exceto na última)
            if i < release_count - 1:
                logger.info(f"[{request_id}] ⏳ Waiting 1s before next request...")
                time.sleep(1)
        
        processing_time = time.time() - start_time
        
        # Verificar se houve falhas (mais tolerante)
        successful_requests = len(responses)
        if successful_requests == 0:
            error_msg = f"Failed to complete any of {release_count} requests"
            async_results[request_id] = {'status': 'failed', 'error': error_msg, 'timestamp': time.time()}
            logger.error(f"[{request_id}] 💥 Background processing FAILED: {error_msg}")
        elif failed_requests > 0:
            # Houve algumas falhas, mas pelo menos uma requisição foi bem-sucedida
            success_msg = f"Completed {successful_requests}/{release_count} requests (some failures: {failed_requests})"
            async_results[request_id] = {'status': 'partial_success', 'error': None, 'timestamp': time.time()}
            logger.warning(f"[{request_id}] ⚠️ Background processing PARTIAL SUCCESS: {success_msg}")
        else:
            # Todas as requisições foram bem-sucedidas
            async_results[request_id] = {'status': 'success', 'error': None, 'timestamp': time.time()}
            logger.info(f"[{request_id}] 🎉 Background processing completed successfully in {processing_time:.3f}s")
        
    except Exception as e:
        processing_time = time.time() - start_time
        error_msg = f"Background processing failed: {str(e)}"
        async_results[request_id] = {'status': 'failed', 'error': error_msg, 'timestamp': time.time()}
        logger.error(f"[{request_id}] 💥 Background processing failed after {processing_time:.3f}s: {str(e)}")


def process_dryer_remaining_releases(
    machine_id: str,
    target_url: str,
    release_count: int,
    start_index: int,
    request_id: str,
):
    """Continua liberações da secadora em background após o 1º HTTP 200."""
    try:
        for i in range(start_index, release_count):
            if i > start_index:
                time.sleep(1)
            logger.info(
                f"[{request_id}] 📤 Dryer {machine_id} release {i + 1}/{release_count} (background)"
            )
            try:
                resp = requests.get(target_url, timeout=15)
                status_color = Fore.GREEN if resp.status_code == 200 else Fore.RED
                logger.info(
                    f"[{request_id}] ✅ Request {i + 1}: {status_color}{resp.status_code}{Style.RESET_ALL}"
                )
                if resp.status_code != 200:
                    logger.error(
                        f"[{request_id}] 💥 Dryer release {i + 1}/{release_count} failed: "
                        f"HTTP {resp.status_code}"
                    )
                    return
            except Exception as e:
                logger.error(
                    f"[{request_id}] 💥 Dryer release {i + 1}/{release_count} error: {e}"
                )
                return
        logger.info(
            f"[{request_id}] 🎉 Dryer {machine_id} background releases completed "
            f"({release_count} total)"
        )
    except Exception as e:
        logger.error(f"[{request_id}] 💥 Background dryer release failed: {e}")


def process_washer_release_after_doser(machine_id: str, request_id: str):
    """Libera lavadora em background após dosagem confirmada."""
    try:
        logger.info(f"[{request_id}] 📤 Washer {machine_id} release after doser (background)")
        result = release_machine(machine_id, 'washer')
        if result.get('success'):
            logger.info(
                f"[{request_id}] ✅ Washer {machine_id} released: HTTP {result.get('status_code')}"
            )
        else:
            logger.error(
                f"[{request_id}] 💥 Washer {machine_id} release failed: "
                f"{result.get('error') or result.get('status_code')}"
            )
    except Exception as e:
        logger.error(f"[{request_id}] 💥 Background washer release failed: {e}")


def send_dosadora_command(dosadora_ip: str, endpoint: str, timeout: int | None = None) -> dict:
    """Envia comando para a dosadora (IP da API Lav60 ou mapa fixo)."""
    if timeout is None:
        timeout = DOSER_HTTP_TIMEOUT
    address = normalize_device_address(dosadora_ip)
    try:
        url = device_http_url(address, endpoint)
        logger.info(f"   {Fore.CYAN}📤 Sending command to {address}: {endpoint}{Style.RESET_ALL}")
        
        response = requests.get(url, timeout=timeout)
        
        status_color = Fore.GREEN if response.status_code == 200 else Fore.RED
        logger.info(f"   {Fore.GREEN}✅ Command sent: {status_color}{response.status_code}{Style.RESET_ALL}")
        
        return {
            'success': True,
            'status_code': response.status_code,
            'response': response.text,
            'url': url
        }
    except requests.exceptions.Timeout:
        logger.error(f"   {Fore.RED}⏰ Timeout sending command to {address}{Style.RESET_ALL}")
        return {'success': False, 'error': 'Timeout', 'url': device_http_url(address, endpoint)}
    except requests.exceptions.ConnectionError:
        logger.error(f"   {Fore.RED}🔌 Connection error to {address}{Style.RESET_ALL}")
        return {'success': False, 'error': 'Connection Error', 'url': device_http_url(address, endpoint)}
    except Exception as e:
        logger.error(f"   {Fore.RED}💥 Error sending command to {address}: {str(e)}{Style.RESET_ALL}")
        return {'success': False, 'error': str(e), 'url': device_http_url(address, endpoint)}


def send_ac_command(device_path: str, temperature: str = '', timeout: int = 10) -> dict:
    """Envia comando HTTP ao ar-condicionado (ESP8266 na rede local)."""
    path = device_path if device_path.startswith('/') else f'/{device_path}'
    url = f'http://{AC_IP}{path}'
    temp_label = 'Desligar' if str(temperature).lower() == 'off' else f'{temperature}°C'
    try:
        logger.info(
            f"   {Fore.CYAN}❄️ Ar-condicionado {AC_IP}{path} ({temp_label}){Style.RESET_ALL}"
        )
        response = requests.get(url, timeout=timeout)
        status_color = Fore.GREEN if response.status_code == 200 else Fore.RED
        logger.info(
            f"   {status_color}✅ AC command HTTP {response.status_code}{Style.RESET_ALL}"
        )
        return {
            'success': response.status_code == 200,
            'status_code': response.status_code,
            'response': response.text,
            'url': url,
        }
    except requests.exceptions.Timeout:
        logger.error(f"   {Fore.RED}⏰ Timeout AC {AC_IP}{path}{Style.RESET_ALL}")
        return {'success': False, 'error': 'Timeout', 'url': url}
    except requests.exceptions.ConnectionError:
        logger.error(f"   {Fore.RED}🔌 Connection error AC {AC_IP}{path}{Style.RESET_ALL}")
        return {'success': False, 'error': 'Connection Error', 'url': url}
    except Exception as e:
        logger.error(f"   {Fore.RED}💥 Error AC {AC_IP}{path}: {str(e)}{Style.RESET_ALL}")
        return {'success': False, 'error': str(e), 'url': url}


def resolve_dosadora_endpoint(softener_type: str, dosage_type: str = '') -> str | None:
    """Retorna o único endpoint HTTP a enviar à dosadora."""
    softener = softener_type.upper()
    if softener in ('SEM_AMACIANTE', 'DISABLE'):
        return DOSADORA_SEM_CHEIRO_ENDPOINT
    dosage = dosage_type.upper().strip()
    return DOSADORA_DOSAGE_ENDPOINTS.get((softener, dosage))


def configure_dosadora(dosadora_ip: str, softener_type: str, dosage_type: str) -> dict:
    """Configura a dosadora — um único GET no endpoint de dosagem (ou /softener0 sem cheiro)."""
    softener = softener_type.upper()
    dosage = dosage_type.upper().strip() if dosage_type else ''

    endpoint = resolve_dosadora_endpoint(softener, dosage)
    if not endpoint:
        return {
            'success': False,
            'error': f'Combinação inválida: softener={softener}, dosage={dosage or "(vazio)"}',
            'results': [],
            'type': 'dosadora',
        }

    try:
        logger.info(f"   {Fore.CYAN}🔧 Dosadora {dosadora_ip} → {endpoint} ({softener}/{dosage or "sem cheiro"}){Style.RESET_ALL}")
        result = send_dosadora_command(dosadora_ip, endpoint)
        ok = result.get('status_code') == 200

        return {
            'success': ok,
            'total_commands': 1,
            'successful_commands': 1 if ok else 0,
            'results': [result],
            'configuration': {
                'softener': softener,
                'dosage': dosage or None,
                'endpoint': endpoint,
            },
            'type': 'dosadora',
            'error': None if ok else result.get('error', f'HTTP {result.get("status_code")}'),
        }
    except Exception as e:
        logger.error(f"   {Fore.RED}💥 Error configuring dosadora: {str(e)}{Style.RESET_ALL}")
        return {'success': False, 'error': str(e), 'results': [], 'type': 'dosadora'}


def configure_dosadora_on_release(dosadora_ip: str, softener_type: str) -> dict | None:
    """
    Configuração de dosadora durante POST /api/release.
    Apenas sem cheiro (SEM_AMACIANTE/DISABLE) → /softener0.
    FLORAL/SPORT → não envia (use POST /api/doser/configure).
    """
    endpoint = resolve_dosadora_endpoint(softener_type, '')
    if endpoint != DOSADORA_SEM_CHEIRO_ENDPOINT:
        return None

    softener = softener_type.upper()
    logger.info(f"   {Fore.CYAN}🔧 Release + dosadora sem cheiro: {dosadora_ip} → {endpoint}{Style.RESET_ALL}")
    result = send_dosadora_command(dosadora_ip, endpoint)
    ok = result.get('status_code') == 200

    return {
        'success': ok,
        'total_commands': 1,
        'successful_commands': 1 if ok else 0,
        'results': [result],
        'configuration': {'softener': softener, 'dosage': None, 'endpoint': endpoint},
        'type': 'dosadora_release',
        'error': None if ok else result.get('error', f'HTTP {result.get("status_code")}'),
    }


def normalize_dosadora_product(product: str) -> str:
    key = product.strip().lower()
    if key in DOSADORA_RELAY_ALIASES:
        return DOSADORA_RELAY_ALIASES[key]
    return product.strip().upper()


def trigger_dosadora_relay(dosadora_ip: str, product: str) -> dict:
    """Aciona relé da dosadora: SABAO→/rele1on, FLORAL→/rele2on, SPORT→/rele3on."""
    normalized = normalize_dosadora_product(product)
    endpoint = DOSADORA_RELAY_ENDPOINTS.get(normalized)
    if not endpoint:
        return {
            'success': False,
            'error': f'Produto inválido: {product}. Use SABAO, FLORAL ou SPORT',
        }

    logger.info(f"   {Fore.CYAN}⚡ Acionando dosadora {dosadora_ip} → {endpoint} ({normalized}){Style.RESET_ALL}")
    result = send_dosadora_command(dosadora_ip, endpoint)
    ok = result.get('status_code') == 200

    return {
        'success': ok,
        'product': normalized,
        'endpoint': endpoint,
        'url': result.get('url'),
        'status_code': result.get('status_code'),
        'error': None if ok else result.get('error', f'HTTP {result.get("status_code")}'),
    }

# Middleware para logar todas as requisições
@app.before_request
def log_request_middleware():
    """Log compacto de requisições recebidas."""
    global last_inbound_request_at, last_inbound_client_ip

    request_id = f"req_{int(time.time() * 1000)}"
    client_ip = request_client_ip()
    request.request_id = request_id
    request._request_start = time.time()
    last_inbound_request_at = request._request_start
    last_inbound_client_ip = client_ip

    log_request_info(request_id, request.method, request.url, client_ip)

    if request.args and not should_skip_access_log(request.path, request.method):
        logger.info(f"   query: {Fore.WHITE}{dict(request.args)}{Style.RESET_ALL}")

    body = request.get_json(silent=True)
    if body and is_gateway_operation(request.path, request.method):
        logger.info(f"   body: {Fore.WHITE}{body}{Style.RESET_ALL}")

@app.before_request
def validate_store_agent_identity():
    """Cada agente só atende rotas da própria loja (STORE_ID do Windows)."""
    if request.method == 'OPTIONS':
        return
    parts = [p for p in request.path.strip('/').split('/') if p]
    if len(parts) < 2 or parts[1] not in GATEWAY_STORE_ROUTE_ACTIONS:
        return
    url_store = normalize_store_id(parts[0])
    try:
        env_store = normalize_store_id(require_store_id())
    except RuntimeError as e:
        return gateway_error(str(e), 503)
    if url_store != env_store:
        return gateway_error(
            f'Este agente é {env_store.upper()}. Requisição para {url_store.upper()} recusada.',
            403,
        )

@app.before_request
def verify_api_token():
    """Auth opcional via X-Token (mesmo padrão do main.py / MQTT Gateway)."""
    if not API_TOKEN:
        return
    path = request.path
    if path in GATEWAY_PUBLIC_PATHS:
        return
    if path.startswith(('/debug', '/tunnel', '/provision', '/cleanup', '/api/tunnel')):
        return
    if path.startswith(('/api/devices', '/api/network-status', '/network-status', '/ping-status', '/api/status')):
        if request.headers.get('X-Token') != API_TOKEN:
            return jsonify({'detail': 'Invalid or missing X-Token header.'}), 401
    parts = [p for p in path.strip('/').split('/') if p]
    if len(parts) >= 2 and parts[1] in ('washer', 'dryer', 'doser', 'ac', 'status', 'led', 'devices'):
        if request.headers.get('X-Token') != API_TOKEN:
            return jsonify({'detail': 'Invalid or missing X-Token header.'}), 401


@app.after_request
def log_response_middleware(response):
    """Log compacto da resposta enviada."""
    request_id = getattr(request, 'request_id', 'unknown')
    start = getattr(request, '_request_start', None)
    processing_time = time.time() - start if start else 0
    size = response.content_length
    if size is None:
        try:
            size = len(response.get_data())
        except Exception:
            size = 0

    if request.path in SKIP_ACCESS_LOG_PATHS:
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'

    log_response_info(request_id, response.status_code, processing_time, size or 0)
    return response

# Variável global para armazenar o processo do tunnel
tunnel_process = None
_tunnel_log_file = None
_cloudflared_path: str | None = None

# Controle de instância única
LOCK_FILE = Path.home() / '.cloudflare_tunnel_proxy.lock'
SERVER_PORT = int(os.getenv('SERVER_PORT', '8080'))

# Mapeamento de dispositivos (IDs numéricos)
WASHER_MAP = {
    '321': f'{NETWORK_BASE_IP}.100',
    '432': f'{NETWORK_BASE_IP}.101',
    '543': f'{NETWORK_BASE_IP}.102',
    '654': f'{NETWORK_BASE_IP}.103',
}

DRYER_MAP = {
    '210': f'{NETWORK_BASE_IP}.107',
    '765': f'{NETWORK_BASE_IP}.104',
    '876': f'{NETWORK_BASE_IP}.105',
    '987': f'{NETWORK_BASE_IP}.106',
}

DOSADORA_MAP = {
    '321': f'{NETWORK_BASE_IP}.150',
    '432': f'{NETWORK_BASE_IP}.151',
    '543': f'{NETWORK_BASE_IP}.152',
    '654': f'{NETWORK_BASE_IP}.153',
}

AC_ID = '110'
AC_IP = f'{NETWORK_BASE_IP}.110'

# Ocultar no frontend quando offline (ping). Demais equipamentos permanecem visíveis offline.
FRONTEND_HIDE_WHEN_OFFLINE: frozenset[tuple[str, str]] = frozenset({
    ('washer', '321'),
    ('dryer', '210'),
    ('doser', '321'),
})

WASHER_IDS = list(WASHER_MAP.keys())
DRYER_IDS = list(DRYER_MAP.keys())
MACHINE_MAP = {mid: ip.rsplit('.', 1)[-1] for mid, ip in {**WASHER_MAP, **DRYER_MAP}.items()}


def normalize_machine_capacity(raw: str | None) -> str:
    key = str(raw or '').strip().lower()
    return MACHINE_CAPACITY_LABELS.get(key, key or '—')


def normalize_api_machine_status(raw: str | None) -> str:
    status = str(raw or 'unknown').strip().lower()
    if status == 'busy':
        return 'occupied'
    if status in ('suspended', 'suspensa', 'suspens') or status.startswith('suspend'):
        return 'suspended'
    return status


def machine_status_label(status: str, raw: str | None = None) -> str:
    key = normalize_api_machine_status(status or raw)
    if key in MACHINE_STATUS_LABELS:
        return MACHINE_STATUS_LABELS[key]
    label = str(raw or status or 'unknown').strip()
    return label.replace('_', ' ').title() if label else '—'


def normalize_api_machine_type(raw: str | None) -> str:
    value = str(raw or '').strip().lower().replace('_', '-')
    aliases = {
        'washer': 'washer', 'lavadora': 'washer', 'washers': 'washer',
        'dryer': 'dryer', 'secadora': 'dryer', 'dryers': 'dryer',
        'doser': 'doser', 'dosadora': 'doser', 'dosadoras': 'doser',
        'ac': 'ac', 'ar': 'ac', 'air-conditioner': 'ac',
    }
    return aliases.get(value, '')


def _machines_auth_headers_list() -> list[dict[str, str]]:
    """Candidatos de autenticação para API Lav60 (header X-Token), em ordem de tentativa."""
    import base64

    base = {'Accept': 'application/json'}
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    auth_mode = (os.getenv('LAV60_MACHINES_AUTH') or 'x-token').strip().lower()

    def add_x_token(token: str) -> None:
        value = token.strip()
        if not value or value in seen:
            return
        seen.add(value)
        out.append({**base, 'X-Token': value})

    def add_authorization(authorization: str) -> None:
        key = authorization.strip()
        if not key or key in seen:
            return
        seen.add(key)
        out.append({**base, 'Authorization': key})

    lav60 = (
        os.getenv('LAV60_API_TOKEN')
        or _windows_env('LAV60_API_TOKEN')
        or MACHINES_API_TOKEN
        or ''
    ).strip()
    api_tok = (os.getenv('API_TOKEN') or _windows_env('API_TOKEN') or '').strip()

    if auth_mode in ('auto', 'x-token', 'xtoken', 'x_token'):
        if lav60:
            add_x_token(lav60)
        if api_tok and api_tok != lav60:
            add_x_token(api_tok)

    if auth_mode in ('auto', 'bearer') and lav60:
        add_authorization(lav60 if lav60.lower().startswith('bearer ') else f'Bearer {lav60}')

    if auth_mode in ('auto', 'basic') and api_tok:
        if api_tok.lower().startswith('basic '):
            add_authorization(api_tok)
        elif re.fullmatch(r'[A-Za-z0-9+/=]+', api_tok):
            add_authorization(f'Basic {api_tok}')
        elif ':' in api_tok:
            encoded = base64.b64encode(api_tok.encode('utf-8')).decode('ascii')
            add_authorization(f'Basic {encoded}')

    if not out:
        out.append(dict(base))
    return out


def machines_api_headers() -> dict:
    headers_list = _machines_auth_headers_list()
    return headers_list[0] if headers_list else {'Accept': 'application/json'}


def parse_machines_api_payload(payload: dict, store_code: str) -> dict:
    """Converte JSON da API Lav60 em catálogo interno + mapas de IP."""
    items = payload.get('data') or []
    machines: list[dict] = []
    washer_map: dict[str, str] = {}
    dryer_map: dict[str, str] = {}
    doser_map: dict[str, str] = {}

    for item in items:
        attrs = item.get('attributes') or {}
        mid = normalize_machine_id(str(attrs.get('name') or item.get('id') or ''))
        if not mid:
            continue
        mtype = normalize_api_machine_type(attrs.get('machine-type') or attrs.get('machine_type'))
        if not mtype:
            continue
        address = normalize_device_address(str(attrs.get('address') or '').strip())
        status_raw = str(attrs.get('status') or 'unknown').strip().lower()
        status = normalize_api_machine_status(status_raw)
        capacity_raw = attrs.get('machine-capacity') or attrs.get('machine_capacity') or ''
        machine_type_raw = attrs.get('machine-type') or attrs.get('machine_type') or ''
        waiting = attrs.get('waiting-minutes') if attrs.get('waiting-minutes') is not None else attrs.get('waiting_minutes')
        liter = attrs.get('liter-capacity') if attrs.get('liter-capacity') is not None else attrs.get('liter_capacity')
        time_dosage = attrs.get('time_dosage') if attrs.get('time_dosage') is not None else attrs.get('time-dosage')
        port = attrs.get('port')
        machine = {
            'api_id': str(item.get('id') or ''),
            'resource_type': str(item.get('type') or ''),
            'id': mid,
            'type': mtype,
            'machine_type': str(machine_type_raw or mtype),
            'machine_type_label': MACHINE_TYPE_LABELS.get(mtype, str(machine_type_raw or mtype)),
            'address': address,
            'status': status,
            'status_raw': status_raw,
            'status_label': machine_status_label(status, status_raw),
            'capacity': normalize_machine_capacity(capacity_raw),
            'capacity_raw': str(capacity_raw or ''),
            'liter_capacity': liter,
            'waiting_minutes': waiting,
            'time_dosage': time_dosage,
            'port': port,
            'store_code': attrs.get('store_code') or store_code,
            'endpoints': {},
        }
        if address:
            if mtype in ('washer', 'dryer'):
                machine['endpoints']['release'] = device_http_url(address, '/lb')
            if mtype == 'doser':
                machine['endpoints']['status'] = device_http_url(address, '/status')
        machines.append(machine)
        if not address:
            continue
        if mtype == 'washer':
            washer_map[mid] = address
        elif mtype == 'dryer':
            dryer_map[mid] = address
        elif mtype == 'doser':
            doser_map[mid] = address

    machines.sort(key=lambda m: (m['type'], m['id']))
    return {
        'store_code': store_code.upper(),
        'fetched_at': datetime.now().isoformat(),
        'source': 'lav60_api',
        'machines': machines,
        'washer_map': washer_map,
        'dryer_map': dryer_map,
        'doser_map': doser_map,
    }


def fetch_store_machines_from_api(store_code: str) -> dict | None:
    """GET /api/v1/machines?store_code={STORE_ID}"""
    if not MACHINES_API_URL:
        return None
    params = {'store_code': store_code.upper()}
    headers_list = _machines_auth_headers_list()
    last_status: int | None = None
    last_body = ''

    def log_machines_api_error(status: int, body: str) -> None:
        if status == 400 and 'suspend' in (body or '').lower():
            logger.info(
                f"{Fore.YELLOW}🏭 Loja {store_code.upper()} suspensa no sistema Lav60 "
                f"— operação local e heartbeat continuam{Style.RESET_ALL}"
            )
            return
        logger.warning('API máquinas HTTP %s: %s', status, body)

    try:
        for headers in headers_list:
            response = requests.get(
                MACHINES_API_URL,
                params=params,
                headers=headers,
                timeout=20,
            )
            last_status = response.status_code
            last_body = (response.text or '')[:200]
            if response.status_code == 401:
                continue
            if response.status_code >= 400:
                log_machines_api_error(response.status_code, last_body)
                return None
            payload = response.json()
            return parse_machines_api_payload(payload, store_code)

        if last_status == 401:
            return None
        if last_status is not None and last_status >= 400:
            log_machines_api_error(last_status, last_body)
        return None
    except Exception as exc:
        logger.warning('Falha ao consultar API de máquinas: %s', exc)
        return None


def log_store_machines_summary(catalog: dict) -> None:
    machines = catalog.get('machines') or []
    if not machines:
        logger.warning(f"{Fore.YELLOW}🏭 API máquinas: nenhum equipamento retornado{Style.RESET_ALL}")
        return
    logger.info(
        f"{Fore.CYAN}🏭 Máquinas {catalog.get('store_code')} (API Lav60): {len(machines)} cadastrada(s){Style.RESET_ALL}"
    )
    for machine in machines:
        addr = machine.get('address') or '—'
        logger.info(
            f"{Fore.CYAN}   • {machine.get('type', '?'):7}{Style.RESET_ALL} "
            f"{Fore.WHITE}{machine.get('id')}{Style.RESET_ALL}  "
            f"{addr}  "
            f"{machine.get('status_label')}  "
            f"{Fore.YELLOW}{machine.get('capacity')}{Style.RESET_ALL}"
        )


def load_store_machines_catalog(store_code: str) -> dict | None:
    """Consulta API Lav60 ao iniciar o agente."""
    global store_machines_catalog, store_machines_last_refresh
    catalog = fetch_store_machines_from_api(store_code)
    with store_machines_lock:
        if catalog:
            store_machines_catalog = catalog
            store_machines_last_refresh = time.time()
        else:
            store_machines_catalog = None
    if catalog:
        log_store_machines_summary(catalog)
    else:
        token = _resolve_machines_api_token()
        if not token:
            logger.warning(
                f"{Fore.YELLOW}⚠️ LAV60_API_TOKEN ausente — configure no registro Windows "
                f"ou no .env ao lado do executável{Style.RESET_ALL}"
            )
        else:
            logger.warning(
                f"{Fore.YELLOW}⚠️ API Lav60 sem resposta para {store_code.upper()} "
                f"(verifique token e rede){Style.RESET_ALL}"
            )
    return catalog


def refresh_store_machines_catalog_if_due(store_code: str | None = None, *, force: bool = False) -> None:
    """Atualiza status operacional (busy/suspended/available) da API Lav60 com throttle."""
    global store_machines_catalog, store_machines_last_refresh
    if not MACHINES_API_URL:
        return
    code = (store_code or env_store_id()).strip().upper()
    if not code:
        return
    now = time.time()
    with store_machines_lock:
        if not force and now - store_machines_last_refresh < MACHINES_CATALOG_REFRESH_INTERVAL:
            return
    catalog = fetch_store_machines_from_api(code)
    with store_machines_lock:
        if catalog:
            store_machines_catalog = catalog
            store_machines_last_refresh = now
        elif store_machines_catalog is not None:
            store_machines_last_refresh = now


def get_store_machines_snapshot() -> dict | None:
    with store_machines_lock:
        return dict(store_machines_catalog) if store_machines_catalog else None


def get_store_machines_list() -> list[dict]:
    refresh_store_machines_catalog_if_due()
    snap = get_store_machines_snapshot()
    if not snap:
        return []
    return list(snap.get('machines') or [])


def get_washer_map() -> dict[str, str]:
    snap = get_store_machines_snapshot()
    if snap and snap.get('washer_map'):
        return dict(snap['washer_map'])
    return dict(WASHER_MAP)


def get_dryer_map() -> dict[str, str]:
    snap = get_store_machines_snapshot()
    if snap and snap.get('dryer_map'):
        return dict(snap['dryer_map'])
    return dict(DRYER_MAP)


def get_doser_map() -> dict[str, str]:
    snap = get_store_machines_snapshot()
    if snap and snap.get('doser_map'):
        return dict(snap['doser_map'])
    return dict(DOSADORA_MAP)


def normalize_device_address(raw: str | None) -> str:
    """Converte IP da API (completo ou último octeto) em endereço de rede."""
    value = str(raw or '').strip()
    if not value:
        return ''
    if re.match(r'^\d+\.\d+\.\d+\.\d+$', value):
        return value
    if re.match(r'^\d{1,3}$', value):
        return f'{NETWORK_BASE_IP}.{value}'
    return value


def device_http_url(ip: str, path: str = '/lb') -> str:
    """Monta URL HTTP local a partir do IP coletado na API Lav60."""
    address = normalize_device_address(ip)
    suffix = path if path.startswith('/') else f'/{path}'
    return f'http://{address}{suffix}'


def get_washer_ids() -> list[str]:
    return sorted(get_washer_map().keys())


def get_dryer_ids() -> list[str]:
    return sorted(get_dryer_map().keys())


def get_doser_ids() -> list[str]:
    return sorted(get_doser_map().keys())


def is_washer_id(machine_id: str) -> bool:
    return normalize_machine_id(machine_id) in get_washer_map()


def is_dryer_id(machine_id: str) -> bool:
    return normalize_machine_id(machine_id) in get_dryer_map()


def is_doser_id(machine_id: str) -> bool:
    return normalize_machine_id(machine_id) in get_doser_map()


def get_release_url(machine_id: str, device_type: str = 'washer') -> str:
    """URL de liberação lavadora/secadora — IP vem da API Lav60 (fallback mapa fixo)."""
    ip = get_device_ip(machine_id, device_type)
    if not ip:
        raise KeyError(f'Sem IP cadastrado para {device_type}/{machine_id}')
    return device_http_url(ip, '/lb')


def get_device_type_ip_maps() -> dict[str, dict[str, str]]:
    return {
        'washer': get_washer_map(),
        'dryer': get_dryer_map(),
        'doser': get_doser_map(),
    }


def get_ambiguous_device_ids() -> list[str]:
    return sorted(set(get_washer_map()) & set(get_doser_map()))


DEVICE_TYPE_ALIASES = {
    'washer': 'washer', 'lavadora': 'washer', 'lavadoras': 'washer', 'l': 'washer',
    'dryer': 'dryer', 'secadora': 'dryer', 'secadoras': 'dryer', 's': 'dryer',
    'doser': 'doser', 'dosadora': 'doser', 'dosadoras': 'doser', 'd': 'doser',
    'ac': 'ac', 'ar': 'ac', 'ar-condicionado': 'ac', 'a': 'ac',
}


def normalize_machine_id(machine_id: str) -> str:
    """Normaliza ID numérico; aceita prefixo legado L/S/D/A apenas na entrada."""
    machine_id = machine_id.strip().upper()
    if len(machine_id) > 1 and machine_id[0] in 'LSDA' and machine_id[1:].isdigit():
        return machine_id[1:]
    return machine_id


def canonical_device_type(device_type: str) -> str:
    return DEVICE_TYPE_ALIASES.get(device_type.strip().lower(), '')


def get_device_ip(machine_id: str, device_type: str) -> str | None:
    mid = normalize_machine_id(machine_id)
    dtype = canonical_device_type(device_type)
    if dtype == 'ac':
        return AC_IP if mid == AC_ID else None
    ip_maps = {
        'washer': get_washer_map(),
        'dryer': get_dryer_map(),
        'doser': get_doser_map(),
    }
    ip_map = ip_maps.get(dtype)
    if not ip_map:
        return None
    raw = ip_map.get(mid)
    return normalize_device_address(raw) if raw else None


def resolve_device(machine_id: str, device_type: str = '') -> tuple[str, str] | None:
    """Resolve (id_numérico, tipo) — exige type= quando o ID existe em mais de um mapa."""
    mid = normalize_machine_id(machine_id)
    dtype = canonical_device_type(device_type)

    if dtype:
        return (mid, dtype) if get_device_ip(mid, dtype) else None

    matches = list_device_types_for_id(mid)
    if len(matches) == 1:
        return mid, matches[0]
    return None


def list_device_types_for_id(machine_id: str) -> list[str]:
    """Lista tipos de equipamento associados ao ID numérico."""
    mid = normalize_machine_id(machine_id)
    types = []
    if mid in get_washer_map():
        types.append('washer')
    if mid in get_dryer_map():
        types.append('dryer')
    if mid in get_doser_map():
        types.append('doser')
    if mid == AC_ID:
        types.append('ac')
    return types


def build_device_statuses_for_id(machine_id: str, device_types: list[str]) -> dict:
    """Monta status para múltiplos tipos do mesmo ID (ex.: 654 = lavadora + dosadora)."""
    mid = normalize_machine_id(machine_id)
    devices = {}
    for dtype in device_types:
        payload = build_device_status_payload(mid, dtype)
        devices[dtype] = {
            'online': payload['online'],
            'status': payload['status'],
            'ip': payload['ip'],
        }
    return {
        'id': mid,
        'ambiguous': len(device_types) > 1,
        'devices': devices,
        'online': any(d['online'] for d in devices.values()),
        'timestamp': datetime.now().isoformat(),
    }


def _ping_stdout_confirms_target(stdout: str, ip_address: str) -> bool:
    """Exige resposta explícita do IP alvo (evita falso positivo no parse do Windows)."""
    if not stdout or not ip_address:
        return False
    text = stdout.lower()
    ip = ip_address.lower()
    if ip not in text:
        return False
    if 'resposta de' in text or 'reply from' in text:
        return True
    return False


def icmp_ping_once(ip_address: str, count: int | None = None, timeout: int | None = None) -> bool:
    """Um ciclo ICMP — online só com returncode 0 e resposta do IP alvo."""
    import platform

    count = count if count is not None else PING_COUNT
    timeout = timeout if timeout is not None else PING_TIMEOUT

    try:
        if platform.system().lower() == 'windows':
            cmd = ['ping', '-n', str(count), '-w', str(timeout * 1000), ip_address]
        else:
            cmd = ['ping', '-c', str(count), '-W', str(timeout), ip_address]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=(timeout * max(count, 1)) + 8,
        )

        if result.returncode != 0:
            return False

        stdout = result.stdout or ''
        if platform.system().lower() == 'windows':
            return _ping_stdout_confirms_target(stdout, ip_address)

        return _ping_stdout_confirms_target(stdout, ip_address) or result.returncode == 0
    except (subprocess.TimeoutExpired, Exception) as e:
        logger.debug(f"ICMP ping error for {ip_address}: {e}")
        return False


def icmp_ping(ip_address: str, count: int | None = None, timeout: int | None = None) -> bool:
    """ICMP: online na 1ª resposta; offline só após PING_RETRIES falhas consecutivas."""
    attempts = max(1, PING_RETRIES)
    for attempt in range(attempts):
        probe_count = count if count is not None else (PING_COUNT if attempt == 0 else 1)
        if icmp_ping_once(ip_address, probe_count, timeout):
            return True
        if attempt + 1 < attempts:
            time.sleep(PING_RETRY_DELAY)
    return False


def washer_online(ip_address: str) -> bool:
    """Lavadora/secadora: ICMP com retentativas (ESP8266 pode perder pacote sob carga)."""
    return icmp_ping(ip_address)


def dryer_online(ip_address: str) -> bool:
    return icmp_ping(ip_address)


def http_get_ok(url: str, timeout_sec: int | None = None) -> bool:
    """HTTP GET — equivalente a httpGet() no mqtt-esp8266.ino (200-399 ou 303)"""
    timeout_sec = timeout_sec if timeout_sec is not None else DOSER_HTTP_TIMEOUT
    try:
        response = requests.get(url, timeout=timeout_sec)
        code = response.status_code
        return (200 <= code < 400) or code == 303
    except Exception:
        return False


def doser_online(ip_address: str) -> bool:
    """Dosadora: HTTP /status (confirma ESP); fallback ICMP estrito se HTTP falhar."""
    if http_get_ok(f'http://{ip_address}/status', DOSER_HTTP_TIMEOUT):
        return True
    return icmp_ping(ip_address)


def device_online(machine_id: str, device_type: str) -> bool:
    """Verifica conectividade conforme tipo do dispositivo (mesma lógica do firmware ESP)"""
    ip_address = get_device_ip(machine_id, device_type)
    if not ip_address:
        return False
    if canonical_device_type(device_type) == 'doser':
        return doser_online(ip_address)
    if canonical_device_type(device_type) == 'washer':
        return washer_online(ip_address)
    if canonical_device_type(device_type) == 'dryer':
        return dryer_online(ip_address)
    return icmp_ping(ip_address)


def _ping_device_map(device_map: dict, online_fn=None) -> dict:
    check_fn = online_fn or icmp_ping
    if not device_map:
        return {}

    def check(item: tuple[str, str]) -> tuple[str, bool]:
        mid, ip = item
        return mid, check_fn(ip)

    workers = min(4, max(1, len(device_map)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return dict(pool.map(check, device_map.items()))


def attach_network_summary(data: dict) -> dict:
    washers_on, washers_total = _count_online_map(data.get('washers', {}))
    dryers_on, dryers_total = _count_online_map(data.get('dryers', {}))
    dosers_on, dosers_total = _count_online_map(data.get('dosers', {}))
    ac_on = 1 if data.get('ac') else 0
    online = washers_on + dryers_on + dosers_on + ac_on
    total = washers_total + dryers_total + dosers_total + 1
    data['summary'] = {
        'total': total,
        'online': online,
        'offline': total - online,
        'categories': {
            'washers': {'online': washers_on, 'total': washers_total},
            'dryers': {'online': dryers_on, 'total': dryers_total},
            'dosers': {'online': dosers_on, 'total': dosers_total},
            'ac': {'online': ac_on, 'total': 1},
        },
    }
    return data


def get_cached_network_status() -> dict | None:
    with network_status_lock:
        return dict(last_network_status) if last_network_status else None


def registered_device_keys() -> frozenset[tuple[str, str]] | None:
    """Equipamentos cadastrados na API Lav60. None = catálogo indisponível (mapa fixo local)."""
    if get_store_machines_snapshot() is None:
        return None
    keys: set[tuple[str, str]] = set()
    for machine in get_store_machines_list():
        dtype = canonical_device_type(machine.get('type', '')) or str(machine.get('type', '')).strip().lower()
        mid = normalize_machine_id(str(machine.get('id', '')))
        if dtype in ('washer', 'dryer', 'doser') and mid:
            keys.add((dtype, mid))
    return frozenset(keys)


def is_device_registered_in_catalog(device_type: str, machine_id: str) -> bool:
    """Lav/sec exigem API Lav60; dosadoras usam mapa local (ping). Extras 321/210/321 só na API."""
    dtype = canonical_device_type(device_type) or str(device_type or '').strip().lower()
    mid = normalize_machine_id(machine_id)
    if (dtype, mid) in FRONTEND_HIDE_WHEN_OFFLINE:
        registered = registered_device_keys()
        if registered is None:
            return False
        return (dtype, mid) in registered
    if dtype == 'doser':
        return mid in get_doser_map()
    registered = registered_device_keys()
    if registered is None:
        return (dtype, mid) not in FRONTEND_HIDE_WHEN_OFFLINE
    return (dtype, mid) in registered


def is_device_visible_in_frontend(device_type: str, machine_id: str, network: dict | None = None) -> bool:
    """True = mostrar no painel. Lav/sec exigem API; dosadoras só ping; 321/210/321 exigem online."""
    if not is_device_registered_in_catalog(device_type, machine_id):
        return False
    mid = normalize_machine_id(machine_id)
    dtype = canonical_device_type(device_type) or str(device_type or '').strip().lower()
    if (dtype, mid) not in FRONTEND_HIDE_WHEN_OFFLINE:
        return True
    net = network if network is not None else get_cached_network_status()
    if not net:
        return False
    group_key = {'washer': 'washers', 'dryer': 'dryers', 'doser': 'dosers'}.get(dtype)
    if not group_key:
        return False
    items = net.get(group_key) or {}
    return items.get(mid) is True


def filter_machines_for_frontend(machines: list[dict], network: dict | None = None) -> list[dict]:
    return [
        m for m in (machines or [])
        if is_device_visible_in_frontend(m.get('type', ''), m.get('id', ''), network)
    ]


def filter_network_status_for_frontend(data: dict | None) -> dict | None:
    """Remove do payload público equipamentos configurados para ocultar quando offline."""
    if not data:
        return data
    out = dict(data)
    for group_key, dtype in (('washers', 'washer'), ('dryers', 'dryer'), ('dosers', 'doser')):
        block = dict(out.get(group_key) or {})
        out[group_key] = {
            mid: online
            for mid, online in block.items()
            if is_device_visible_in_frontend(dtype, mid, data)
        }
    return attach_network_summary(out)


def _count_online_map(items: dict) -> tuple[int, int]:
    if not items:
        return 0, 0
    online = sum(1 for v in items.values() if v)
    return online, len(items)


def log_network_status_summary(data: dict) -> None:
    summary = data.get('summary', {})
    offline = []
    for label, items in (
        ('washer', data.get('washers', {})),
        ('dryer', data.get('dryers', {})),
        ('doser', data.get('dosers', {})),
    ):
        for mid, ok in items.items():
            if not ok:
                offline.append(f'{label}/{mid}')
    if not data.get('ac'):
        offline.append('ac')

    online = summary.get('online', '?')
    total = summary.get('total', '?')
    if offline:
        logger.warning(
            f"{Fore.YELLOW}📡 Network check: {online}/{total} online — "
            f"offline: {', '.join(offline)}{Style.RESET_ALL}"
        )
    else:
        logger.info(
            f"{Fore.GREEN}📡 Network check: all {total} devices online{Style.RESET_ALL}"
        )


def monitor_network_devices():
    """Verifica dispositivos na rede local a cada NETWORK_CHECK_INTERVAL segundos."""
    global last_network_status, network_monitoring

    logger.info(
        f"{Fore.CYAN}📡 Starting network device monitoring "
        f"(interval: {NETWORK_CHECK_INTERVAL}s){Style.RESET_ALL}"
    )

    # Primeira verificação logo ao iniciar (após breve delay para o Flask subir)
    time.sleep(5)

    while network_monitoring:
        try:
            data = attach_network_summary(build_network_status_all())
            with network_status_lock:
                last_network_status = data
            log_network_status_summary(data)
            if panel_heartbeat_enabled:
                send_panel_heartbeat_once()
        except Exception as e:
            logger.error(f"{Fore.RED}💥 Network monitoring error: {str(e)}{Style.RESET_ALL}")

        for _ in range(NETWORK_CHECK_INTERVAL):
            if not network_monitoring:
                break
            time.sleep(1)


def wait_for_initial_network_status(timeout_seconds: int = 45) -> bool:
    """Aguarda a primeira leitura de dispositivos antes do heartbeat inicial."""
    for _ in range(max(1, timeout_seconds)):
        with network_status_lock:
            if last_network_status:
                return True
        time.sleep(1)
    return False


def agent_static_public_url() -> str:
    return f'https://{store_hostname(require_store_id())}'


def build_panel_heartbeat_payload() -> dict:
    """Monta payload do heartbeat com leitura fresca da rede (espelha GET /{store}/status)."""
    global last_network_status
    network = None
    try:
        data = attach_network_summary(build_network_status_all())
        with network_status_lock:
            last_network_status = data
        network = data
    except Exception as exc:
        logger.warning(f"{Fore.YELLOW}💓 Heartbeat: falha ao ler rede — {exc}{Style.RESET_ALL}")
        with network_status_lock:
            network = dict(last_network_status) if last_network_status else None
    return {
        'store': require_store_id().lower(),
        'agent_url': agent_static_public_url(),
        'agent_local_url': 'http://127.0.0.1:8080',
        'timestamp': datetime.now().isoformat(),
        'network': filter_network_status_for_frontend(network),
        'machines': filter_machines_for_frontend(get_store_machines_list(), network),
    }


def _panel_heartbeat_token() -> str:
    """Token do POST /api/heartbeat: registro Windows → .env (gateway local continua só Windows)."""
    if os.name == 'nt':
        reg = _read_windows_registry_env('API_TOKEN')
        if reg:
            return reg
        return _ENV_FILE_API_TOKEN
    return (os.environ.get('API_TOKEN') or _ENV_FILE_API_TOKEN or '').strip()


def send_panel_heartbeat_once() -> bool:
    global _cached_working_panel_url
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    panel_token = _panel_heartbeat_token()
    if panel_token:
        headers['X-Token'] = panel_token
    payload = build_panel_heartbeat_payload()
    errors: list[str] = []

    for url in get_panel_heartbeat_url_candidates():
        try:
            response = requests.post(
                url,
                json=payload,
                headers=headers,
                timeout=PANEL_HEARTBEAT_TRY_TIMEOUT,
            )
            if response.status_code >= 400:
                detail = f'HTTP {response.status_code}'
                if response.status_code == 401:
                    detail += ' — X-Token diferente do painel (API_TOKEN no .env da VPS)'
                errors.append(f'{url}: {detail}')
                continue
            if _cached_working_panel_url != url:
                logger.info(f"{Fore.GREEN}💓 Heartbeat painel OK → {url}{Style.RESET_ALL}")
            _cached_working_panel_url = url
            return True
        except Exception as exc:
            errors.append(f'{url}: {exc}')

    logger.warning(
        f"{Fore.YELLOW}💓 Heartbeat painel falhou — painel inacessível "
        f"({' | '.join(errors) if errors else 'sem URL'}){Style.RESET_ALL}"
    )
    return False


def monitor_panel_heartbeat():
    """Envia heartbeat ao painel central a cada HEARTBEAT_INTERVAL segundos."""
    global panel_heartbeat_enabled
    logger.info(
        f"{Fore.CYAN}💓 Heartbeat painel (tentativas: {', '.join(get_panel_heartbeat_url_candidates())}) "
        f"a cada {HEARTBEAT_INTERVAL}s{Style.RESET_ALL}"
    )
    if wait_for_initial_network_status():
        logger.info(f"{Fore.CYAN}💓 Dispositivos lidos — heartbeat incluirá status da rede{Style.RESET_ALL}")
    else:
        logger.warning(
            f"{Fore.YELLOW}💓 Heartbeat sem status de rede (primeira leitura ainda pendente){Style.RESET_ALL}"
        )
    send_panel_heartbeat_once()
    while panel_heartbeat_enabled:
        for _ in range(max(1, HEARTBEAT_INTERVAL)):
            if not panel_heartbeat_enabled:
                break
            time.sleep(1)
        if panel_heartbeat_enabled:
            send_panel_heartbeat_once()


def build_network_status_all() -> dict:
    """Status de todos os dispositivos — equivalente a ping/all no mqtt-esp8266.ino"""
    washers = _ping_device_map(get_washer_map(), washer_online)
    dryers = _ping_device_map(get_dryer_map(), dryer_online)
    dosers = _ping_device_map(get_doser_map(), doser_online)
    ac = icmp_ping(AC_IP)

    return {
        'washers': washers,
        'dryers': dryers,
        'ac': ac,
        'dosers': dosers,
        'timestamp': datetime.now().isoformat(),
    }


def build_device_status_payload(machine_id: str, device_type: str) -> dict:
    """Payload individual — equivalente a publishDeviceStatus() no .ino"""
    mid = normalize_machine_id(machine_id)
    dtype = canonical_device_type(device_type)
    online = device_online(mid, dtype)

    return {
        'id': mid,
        'device_type': dtype,
        'ip': get_device_ip(mid, dtype),
        'online': online,
        'status': 'online' if online else 'offline',
        'timestamp': datetime.now().isoformat(),
    }

ORIGIN_CERTIFICATE = '''-----BEGIN ARGO TUNNEL TOKEN-----
eyJ6b25lSUQiOiJkMTQ2YzgyZThjZDAxOTk0OGJmMWQyOTZiMGNkYzRiZCIsImFj
Y291bnRJRCI6ImVjNTVmOWYzZDVkZDk0MDQwMmU5MDc3OWEwNzUxZjM0IiwiYXBp
VG9rZW4iOiJsbUFLOUxnS29pbFN0QzNyTFE5TTdPczVOdG1GcDFzVXltTVJDRXZy
In0=
-----END ARGO TUNNEL TOKEN-----
'''

def check_port_in_use(port: int) -> bool:
    """Verifica se uma porta está em uso"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            result = s.connect_ex(('localhost', port))
            return result == 0
    except Exception:
        return False

def find_processes_using_port(port: int) -> list[psutil.Process]:
    """Encontra processos que estão usando uma porta específica"""
    processes = []
    try:
        for conn in psutil.net_connections(kind='inet'):
            if conn.laddr.port == port and conn.status == psutil.CONN_LISTEN:
                try:
                    proc = psutil.Process(conn.pid)
                    processes.append(proc)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
    except Exception as e:
        logger.warning(f"Erro ao verificar processos na porta {port}: {e}")
    return processes

def find_cloudflared_processes() -> list[psutil.Process]:
    """Encontra todos os processos cloudflared rodando"""
    cloudflared_processes = []
    try:
        for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
            try:
                # Verificar se o processo ainda está rodando
                if not proc.is_running():
                    continue
                
                # Verificar por nome do processo
                if proc.info['name'] and 'cloudflared' in proc.info['name'].lower():
                    cloudflared_processes.append(proc)
                    continue
                
                # Verificar por linha de comando
                if proc.info['cmdline']:
                    cmdline = ' '.join(proc.info['cmdline']).lower()
                    if 'cloudflared' in cmdline:
                        cloudflared_processes.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
            except Exception:
                # Ignorar outros erros durante a iteração
                continue
    except Exception as e:
        logger.warning(f"Erro ao buscar processos cloudflared: {e}")
    
    return cloudflared_processes

def kill_cloudflared_processes() -> int:
    """Mata todos os processos cloudflared encontrados"""
    killed_count = 0
    
    try:
        cloudflared_processes = find_cloudflared_processes()
        
        if not cloudflared_processes:
            logger.info(f"{Fore.GREEN}✅ No cloudflared processes found{Style.RESET_ALL}")
            return 0
        
        logger.info(f"{Fore.YELLOW}🔍 Found {len(cloudflared_processes)} cloudflared process(es){Style.RESET_ALL}")
        
        for proc in cloudflared_processes:
            try:
                # Verificar se o processo ainda existe antes de tentar acessá-lo
                if not proc.is_running():
                    continue
                    
                log_process_info("Cloudflared", f"Terminating {proc.name()}", proc.pid)
                
                # Tentar finalização graciosa primeiro
                proc.terminate()
                
                # Aguardar o processo terminar
                try:
                    proc.wait(timeout=3)  # Reduzir timeout para evitar travamentos
                    logger.info(f"   {Fore.GREEN}✅ Process {proc.pid} terminated successfully{Style.RESET_ALL}")
                    killed_count += 1
                except psutil.TimeoutExpired:
                    logger.warning(f"   {Fore.YELLOW}⚠️ Process {proc.pid} didn't respond, forcing kill{Style.RESET_ALL}")
                    try:
                        proc.kill()
                        killed_count += 1
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass  # Processo já foi finalizado
                    
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                # Processo já foi finalizado ou não é mais acessível
                continue
            except Exception as e:
                logger.warning(f"   {Fore.YELLOW}⚠️ Error handling process: {e}{Style.RESET_ALL}")
                continue
        
        if killed_count > 0:
            logger.info(f"{Fore.GREEN}✅ Successfully terminated {killed_count} cloudflared process(es){Style.RESET_ALL}")
        
    except Exception as e:
        logger.warning(f"{Fore.YELLOW}⚠️ Error during cloudflared cleanup: {e}{Style.RESET_ALL}")
    
    return killed_count

def kill_processes_on_port(port: int, exclude_pids: set[int] | None = None) -> int:
    """Mata processos na porta — nunca o PID atual (agente em execução)."""
    killed_count = 0
    excluded = set(exclude_pids or set())
    excluded.add(os.getpid())
    processes = find_processes_using_port(port)

    for proc in processes:
        try:
            if proc.pid in excluded:
                logger.info(
                    f"Ignorando PID {proc.pid} na porta {port} (processo atual ou excluído)"
                )
                continue

            logger.info(f"Encontrado processo {proc.name()} (PID: {proc.pid}) usando porta {port}")

            cmdline = ' '.join(proc.cmdline())
            cmdline_lower = cmdline.lower()
            if (
                'proxy_server.py' in cmdline
                or 'lav60_gateway' in cmdline_lower
                or 'launcher.py' in cmdline_lower
                or 'cloudflare_tunnel_proxy' in cmdline_lower
            ):
                logger.info(f"Finalizando processo {proc.name()} (PID: {proc.pid})")
                proc.terminate()

                try:
                    proc.wait(timeout=5)
                    logger.info(f"Processo {proc.pid} finalizado com sucesso")
                    killed_count += 1
                except psutil.TimeoutExpired:
                    logger.warning(f"Processo {proc.pid} não respondeu ao terminate, forçando kill")
                    proc.kill()
                    killed_count += 1
            else:
                logger.warning(
                    f"Processo {proc.name()} (PID: {proc.pid}) não é relacionado ao nosso servidor, mantendo ativo"
                )

        except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
            logger.warning(f"Não foi possível finalizar processo {proc.pid}: {e}")

    return killed_count

def check_and_cleanup_existing_instances() -> bool:
    """Verifica e limpa instâncias existentes do servidor e cloudflared"""
    log_section("INSTANCE VERIFICATION", "INFO")
    
    # Primeiro, limpar processos cloudflared órfãos
    logger.info(f"{Fore.CYAN}🔍 Checking for existing cloudflared processes...{Style.RESET_ALL}")
    cloudflared_killed = kill_cloudflared_processes()
    if cloudflared_killed > 0:
        logger.info(f"{Fore.YELLOW}⏳ Waiting for processes to terminate...{Style.RESET_ALL}")
        time.sleep(1)  # Aguardar um pouco após finalizar cloudflared
    
    # Verificar se a porta está em uso
    if not check_port_in_use(SERVER_PORT):
        logger.info(f"{Fore.GREEN}✅ Port {SERVER_PORT} is available{Style.RESET_ALL}")
        return True
    
    logger.warning(f"{Fore.YELLOW}⚠️ Port {SERVER_PORT} is in use. Checking processes...{Style.RESET_ALL}")
    
    # Encontrar e finalizar processos existentes
    killed_count = kill_processes_on_port(SERVER_PORT)
    
    if killed_count > 0:
        logger.info(f"{Fore.GREEN}✅ Terminated {killed_count} existing process(es){Style.RESET_ALL}")
        
        # Aguardar um pouco para a porta ser liberada
        logger.info(f"{Fore.YELLOW}⏳ Waiting for port to be released...{Style.RESET_ALL}")
        time.sleep(2)
        
        # Verificar novamente se a porta foi liberada
        if not check_port_in_use(SERVER_PORT):
            logger.info(f"{Fore.GREEN}✅ Port {SERVER_PORT} successfully released{Style.RESET_ALL}")
            return True
        else:
            logger.error(f"{Fore.RED}❌ Port {SERVER_PORT} still in use after cleanup attempt{Style.RESET_ALL}")
            return False
    else:
        logger.error(f"{Fore.RED}❌ No related processes found on port {SERVER_PORT}{Style.RESET_ALL}")
        return False

def create_lock_file() -> bool:
    """Cria arquivo de lock para indicar que o servidor está rodando"""
    try:
        with open(LOCK_FILE, 'w') as f:
            f.write(f"{os.getpid()}\n{time.time()}\n{datetime.now().isoformat()}")
        logger.info(f"{Fore.GREEN}🔒 Lock file created: {LOCK_FILE}{Style.RESET_ALL}")
        return True
    except Exception as e:
        logger.error(f"{Fore.RED}❌ Error creating lock file: {e}{Style.RESET_ALL}")
        return False

def remove_lock_file():
    """Remove arquivo de lock"""
    try:
        if LOCK_FILE.exists():
            LOCK_FILE.unlink()
            logger.info(f"{Fore.GREEN}🔓 Lock file removed{Style.RESET_ALL}")
    except Exception as e:
        logger.warning(f"{Fore.YELLOW}⚠️ Error removing lock file: {e}{Style.RESET_ALL}")

def check_lock_file() -> bool:
    """Verifica se existe um arquivo de lock válido"""
    if not LOCK_FILE.exists():
        return False
    
    try:
        with open(LOCK_FILE, 'r') as f:
            lines = f.readlines()
            if len(lines) >= 1:
                pid = int(lines[0].strip())
                # Verificar se o processo ainda existe
                try:
                    proc = psutil.Process(pid)
                    if proc.is_running():
                        logger.warning(f"Encontrado arquivo de lock com PID {pid} ainda ativo")
                        return True
                except psutil.NoSuchProcess:
                    logger.info(f"Arquivo de lock encontrado mas processo {pid} não existe mais")
                    remove_lock_file()
                    return False
    except Exception as e:
        logger.warning(f"Erro ao verificar arquivo de lock: {e}")
        remove_lock_file()
    
    return False


def _resolve_store_from_request(req) -> tuple[str, str, str]:
    """Retorna (store_id, source, host). Store sempre de STORE_ID (Windows)."""
    try:
        host = req.host.split(':')[0] if getattr(req, 'host', None) else ''
    except Exception:
        host = ''

    env_store = require_store_id()
    return env_store, 'env', host


def release_machine(machine_id: str, device_type: str = 'washer') -> dict:
    """Libera lavadora/secadora via HTTP local (IP da API Lav60)."""
    target_url = get_release_url(machine_id, device_type)
    try:
        response = requests.get(target_url, timeout=10)
        return {
            'success': response.status_code == 200,
            'status_code': response.status_code,
            'url': target_url,
        }
    except Exception as e:
        return {'success': False, 'error': str(e), 'url': target_url}


def build_dosadora_response_info(machine_id: str, params: dict) -> dict | None:
    if not is_doser_id(machine_id):
        return None
    softener = str(params.get('softener', '')).upper()
    if softener not in ('SEM_AMACIANTE', 'DISABLE'):
        return None
    doser_ip = get_device_ip(machine_id, 'doser')
    if not doser_ip:
        return None
    return {
        'configured': True,
        'softener': softener,
        'dosage': None,
        'endpoint': '/softener0',
        'api_type': 'local',
        'ip': doser_ip,
    }


def get_dryer_release_count(timer: int) -> int:
    return DRYER_TIMER_RELEASES.get(timer, 1)


def device_catalog(network: dict | None = None) -> dict:
    net = network if network is not None else get_cached_network_status()
    return {
        'washers': sorted(mid for mid in get_washer_map() if is_device_visible_in_frontend('washer', mid, net)),
        'dryers': sorted(mid for mid in get_dryer_map() if is_device_visible_in_frontend('dryer', mid, net)),
        'dosers': sorted(mid for mid in get_doser_map() if is_device_visible_in_frontend('doser', mid, net)),
        'ac': AC_ID,
    }


def wait_async_release(future, request_id: str, timeout: int) -> tuple[bool, str | None]:
    """Aguarda liberação assíncrona. Retorna (sucesso, mensagem_de_erro)."""
    try:
        future.result(timeout=timeout)
        if request_id in async_results and async_results[request_id]['status'] == 'failed':
            return False, async_results[request_id]['error']
        return True, None
    except Exception as e:
        return False, str(e)


def parse_json_body() -> tuple[dict | None, tuple | None]:
    """Lê corpo JSON de requisições POST. Retorna (params, error_response)."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return None, (jsonify({
            'error': 'Corpo JSON obrigatório',
            'message': 'Envie Content-Type: application/json com um objeto JSON',
            'hint': 'Use https:// (não http://) para evitar redirect que remove o corpo do POST',
        }), 400)

    params = {}
    for key, value in data.items():
        if value is None:
            continue
        params[key] = value.strip() if isinstance(value, str) else value
    return params, None


def parse_action_params() -> tuple[dict | None, tuple | None]:
    """POST → JSON body; GET → query string (legado)."""
    if request.method == 'POST':
        return parse_json_body()
    params = request.args.to_dict()
    if not params:
        host = request.host.split(':')[0]
        return None, (jsonify({
            'error': 'Parâmetros ausentes',
            'message': 'Use POST com JSON ou GET com query string',
            'hint': 'Prefira POST via HTTPS — http:// redireciona e pode remover o corpo JSON',
            'example_post': {
                'method': 'POST',
                'url': f'https://{host}/api/release',
                'headers': {'Content-Type': 'application/json'},
                'body': {'machine': '321'},
            },
            'example_get': f'/api/release?machine=321',
        }), 400)
    return params, None


def action_response(body: dict, status: int, deprecated_get: bool = False):
    """Resposta JSON para endpoints de ação; marca GET legado como deprecated."""
    response = jsonify(body)
    response.status_code = status
    if deprecated_get and request.method == 'GET':
        response.headers['Deprecation'] = 'true'
        response.headers['X-API-Preferred-Method'] = 'POST'
    return response


def parse_doser_id(params: dict) -> str:
    """ID numérico da dosadora — campo padronizado: doser."""
    raw = params.get('doser', params.get('machine', ''))
    return normalize_machine_id(str(raw).strip())


def doser_configure_impl(params: dict) -> tuple[dict, int]:
    """Configura dosadora via API local e opcionalmente libera a lavadora."""
    start_time = time.time()
    doser = parse_doser_id(params)
    softener = str(params.get('softener', '')).upper().strip()
    dosage = str(params.get('dosage', '')).upper().strip()

    if not softener:
        return {'error': "Campo 'softener' é obrigatório"}, 400
    if not doser:
        return {'error': "Campo 'doser' é obrigatório"}, 400
    if not dosage:
        return {'error': "Campo 'dosage' é obrigatório"}, 400
    if softener not in VALID_SOFTENERS:
        return {'error': f'Tipo de amaciante inválido: {softener}'}, 400
    if dosage not in VALID_DOSAGES:
        return {'error': f'Tipo de dosagem inválido: {dosage}'}, 400
    if not is_doser_id(doser):
        return {'error': f'ID de dosadora inválido: {doser}'}, 400

    doser_ip = get_device_ip(doser, 'doser')
    if not doser_ip:
        return {'error': f'IP da dosadora {doser} não cadastrado'}, 400
    result = configure_dosadora(doser_ip, softener, dosage)
    processing_time = round(time.time() - start_time, 3)
    request.processing_time = processing_time

    if not result['success']:
        return {
            'success': False,
            'error': result.get('error', 'Failed to configure doser'),
            'doser': doser,
            'softener': softener,
            'dosage': dosage,
            'processing_time': processing_time,
        }, 500

    release_result = release_machine(doser, 'washer') if is_washer_id(doser) else None
    response_data = {
        'success': True,
        'message': 'Dosadora configurada com sucesso',
        'doser': doser,
        'softener': softener,
        'dosage': dosage,
        'ip': doser_ip,
        'configuration': result['configuration'],
        'commands_executed': result['successful_commands'],
        'total_commands': result['total_commands'],
        'processing_time': processing_time,
    }

    if release_result is not None:
        response_data['washer_release'] = release_result
        if release_result['success']:
            response_data['message'] = 'Dosadora configurada e lavadora liberada com sucesso'
        else:
            response_data['success'] = False
            response_data['message'] = 'Dosadora configurada, mas lavadora está offline'
            response_data['error'] = f'Lavadora {doser} está offline ou inacessível'
            return response_data, 400

    return response_data, 200


def release_machine_impl(params: dict) -> tuple[dict, int]:
    """Libera lavadora ou secadora na rede local."""
    start_time = time.time()
    request_id = getattr(request, 'request_id', f"req_{int(time.time() * 1000)}")
    params = dict(params)

    cleanup_old_async_results()

    logger.info(f"{Fore.CYAN}🔄 Processing release request{Style.RESET_ALL}")
    logger.info(f"   Parameters: {Fore.WHITE}{params}{Style.RESET_ALL}")

    if 'machine' not in params:
        return {'error': "Campo 'machine' é obrigatório"}, 400

    machine_id = normalize_machine_id(str(params['machine']))
    if not is_washer_id(machine_id) and not is_dryer_id(machine_id):
        return {'error': f'ID de máquina inválido: {machine_id}'}, 400

    store_id, store_source, req_host = _resolve_store_from_request(request)
    logger.info(f"   Store: {Fore.WHITE}{store_id}{Style.RESET_ALL} (source: {store_source}, host: {req_host})")

    if store_id:
        queue_auto_provision_if_needed(store_id)

    device_type = 'dryer' if is_dryer_id(machine_id) else 'washer'
    target_url = get_release_url(machine_id, device_type)
    device_ip = get_device_ip(machine_id, device_type)
    logger.info(f"   {Fore.CYAN}🎯 Target: {Fore.WHITE}{machine_id} → {device_ip}{Style.RESET_ALL}")

    dosadora_configured = False
    if is_doser_id(machine_id) and params.get('softener'):
        softener = str(params.get('softener', '')).upper()
        doser_ip = get_device_ip(machine_id, 'doser')
        result = configure_dosadora_on_release(doser_ip, softener) if doser_ip else None
        if result is not None:
            if not result['success']:
                return {
                    'success': False,
                    'message': f'Erro ao configurar dosadora (sem cheiro): {result.get("error", "Erro desconhecido")}',
                    'machine_id': machine_id,
                    'processing_time': round(time.time() - start_time, 2),
                }, 400
            dosadora_configured = True

    is_dryer = is_dryer_id(machine_id)
    timer = int(params.get('timer', 0) or 0) if is_dryer else 0
    release_count = get_dryer_release_count(timer) if is_dryer else 1

    future = thread_executor.submit(
        process_release_async,
        machine_id,
        target_url,
        release_count,
        params,
        request_id,
        start_time,
    )

    if is_dryer and timer in (30, 45):
        processing_time = round(time.time() - start_time, 2)
        request.processing_time = processing_time
        response_data = {
            'success': True,
            'message': 'Máquina liberada com sucesso (processamento em background)',
            'machine_id': machine_id,
            'processing_time': processing_time,
            'background_processing': True,
            'expected_releases': release_count,
        }
        dosadora_info = build_dosadora_response_info(machine_id, params) if dosadora_configured else None
        if dosadora_info:
            response_data['dosadora'] = dosadora_info
        return response_data, 200

    timeout = 60 if is_dryer else 30
    ok, error_msg = wait_async_release(future, request_id, timeout)
    processing_time = round(time.time() - start_time, 2)
    request.processing_time = processing_time

    if not ok:
        device_label = 'secadora' if is_dryer else 'lavadora'
        return {
            'success': False,
            'message': f'Erro ao liberar {device_label}: {error_msg}',
            'machine_id': machine_id,
            'processing_time': processing_time,
        }, 400

    response_data = {
        'success': True,
        'message': 'Máquina liberada com sucesso',
        'machine_id': machine_id,
        'processing_time': processing_time,
    }
    dosadora_info = build_dosadora_response_info(machine_id, params) if dosadora_configured else None
    if dosadora_info:
        response_data['dosadora'] = dosadora_info
    return response_data, 200


def doser_relay_impl(params: dict) -> tuple[dict, int]:
    """Aciona relé da dosadora (sabão, floral ou sport)."""
    start_time = time.time()
    doser = parse_doser_id(params)
    product = str(params.get('product', params.get('produto', ''))).strip()

    if not doser:
        return {'error': "Campo 'doser' é obrigatório"}, 400
    if not product:
        return {'error': "Campo 'product' é obrigatório (SABAO, FLORAL, SPORT)"}, 400
    if not is_doser_id(doser):
        return {'error': f'ID de dosadora inválido: {doser}'}, 400

    doser_ip = get_device_ip(doser, 'doser')
    if not doser_ip:
        return {'error': f'IP da dosadora {doser} não cadastrado'}, 400
    result = trigger_dosadora_relay(doser_ip, product)
    processing_time = round(time.time() - start_time, 3)
    request.processing_time = processing_time

    if not result['success']:
        return {
            'success': False,
            'error': result.get('error', 'Falha ao acionar dosadora'),
            'doser': doser,
            'product': normalize_dosadora_product(product),
            'ip': doser_ip,
            'processing_time': processing_time,
        }, 400

    return {
        'success': True,
        'message': f"Dosadora acionada: {result['product']}",
        'doser': doser,
        'product': result['product'],
        'endpoint': result['endpoint'],
        'url': result['url'],
        'status_code': result['status_code'],
        'ip': doser_ip,
        'processing_time': processing_time,
    }, 200


def parse_json_body_dict() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def normalize_store_id(store: str) -> str:
    return store.strip().lower()


def gateway_json(body: dict, status: int = 200):
    response = jsonify(body)
    response.status_code = status
    return response


def gateway_error(detail: str, status: int = 400):
    return gateway_json({'detail': detail}, status)


def err_nao_respondeu(equipamento: str, status: int = 502):
    return gateway_error(f'{equipamento} não respondeu. Tente novamente.', status)


def err_falha_acao(equipamento: str, status: int = 502):
    return gateway_error(f'Não foi possível acionar {equipamento.lower()}. Tente novamente.', status)


def err_equipamento_invalido(status: int = 400):
    return gateway_error('Equipamento inválido.', status)


def err_parametro_invalido(status: int = 400):
    return gateway_error('Parâmetro inválido. Verifique e tente novamente.', status)


def err_dados_incompletos(status: int = 400):
    return gateway_error('Dados incompletos. Verifique e tente novamente.', status)


def err_comando_invalido(status: int = 400):
    return gateway_error('Comando inválido. Verifique e tente novamente.', status)


def gateway_ok(store: str, topic: str, payload: str, response_data, message: str, extra: dict | None = None):
    body = {
        'store': normalize_store_id(store),
        'topic': topic,
        'payload': payload,
        'response': response_data,
        'message': message,
    }
    if extra:
        body.update(extra)
    return gateway_json(body, 200)


def send_doser_http(doser_id: str, endpoint: str) -> dict:
    path = endpoint if endpoint.startswith('/') else f'/{endpoint}'
    doser_ip = get_device_ip(doser_id, 'doser')
    if not doser_ip:
        return {
            'success': False,
            'error': f'Dosadora {doser_id} sem IP cadastrado',
            'url': '',
        }
    return send_dosadora_command(doser_ip, path)


def build_doser_settime_path(rele: int, seconds: float) -> str:
    """Firmware dosadora: GET /settime?rele=N&time={ms} (API_ENDPOINTS_FB.md §1.3)."""
    ms = int(round(float(seconds) * 1000))
    return f'/settime?rele={rele}&time={ms}'


def format_seconds_payload(seconds: float) -> str:
    if seconds == int(seconds):
        return str(int(seconds))
    return str(seconds)


def normalize_tempo_seconds(value) -> float:
    num = float(str(value).strip())
    if num >= 100:
        num /= 1000.0
    return round(num, 2)


def format_tempo_output(seconds: float):
    if seconds == int(seconds):
        return int(seconds)
    return seconds


def parse_doser_tempo_response(raw: str):
    text = (raw or '').strip()
    if not text:
        return None
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return {
                key: format_tempo_output(normalize_tempo_seconds(val))
                for key, val in data.items()
            }
    except json.JSONDecodeError:
        pass
    try:
        return format_tempo_output(normalize_tempo_seconds(text))
    except (TypeError, ValueError):
        return text


def validate_doser_id(doser_id: str) -> str | None:
    mid = normalize_machine_id(doser_id)
    return mid if is_doser_id(mid) else None


def gateway_release_washer(store: str, machine: str, am: str | None = None):
    mid = normalize_machine_id(machine)
    if not is_washer_id(mid):
        return err_equipamento_invalido()

    store_key = normalize_store_id(store)
    if am:
        if am not in VALID_WASHER_AM:
            return err_parametro_invalido()
        if not is_doser_id(mid):
            return err_falha_acao('A dosagem', 400)
        doser_result = send_doser_http(mid, am)
        if doser_result.get('status_code') != 200:
            return err_falha_acao('A dosagem')
        request_id = getattr(request, 'request_id', f"washer_{mid}_{int(time.time() * 1000)}")
        thread_executor.submit(process_washer_release_after_doser, mid, request_id)
        return gateway_ok(
            store_key, f'{store_key}/washer/{mid}', am, doser_result.get('status_code'),
            f'Doser {am} OK — washer {mid} releasing in background',
            {
                'machine': mid,
                'doser': am,
                'doser_status': doser_result.get('status_code'),
                'washer': 'releasing',
                'background_processing': True,
            },
        )

    wash_result = release_machine(mid, 'washer')
    if not wash_result['success']:
        return err_nao_respondeu('A lavadora')
    return gateway_ok(
        store_key, f'{store_key}/washer/{mid}', 'start', wash_result['status_code'],
        f'Washer {mid} released',
        {'machine': mid, 'washer': 'released'},
    )


def gateway_release_dryer(store: str, machine: str, minutes: int):
    mid = normalize_machine_id(machine)
    if not is_dryer_id(mid):
        return err_equipamento_invalido()
    if minutes not in DRYER_TIMER_RELEASES:
        return err_parametro_invalido()

    store_key = normalize_store_id(store)
    target_url = get_release_url(mid, 'dryer')
    release_count = get_dryer_release_count(minutes)
    request_id = getattr(request, 'request_id', f"dryer_{mid}_{int(time.time() * 1000)}")

    try:
        resp = requests.get(target_url, timeout=10)
        if resp.status_code != 200:
            return err_falha_acao('A secadora')
    except Exception:
        return err_nao_respondeu('A secadora')

    if release_count > 1:
        thread_executor.submit(
            process_dryer_remaining_releases,
            mid,
            target_url,
            release_count,
            1,
            request_id,
        )
        return gateway_ok(
            store_key,
            f'{store_key}/dryer/{mid}',
            str(minutes),
            resp.status_code,
            f'Dryer {mid} started for {minutes} min (remaining releases in background)',
            {
                'machine': mid,
                'minutes': minutes,
                'releases': release_count,
                'completed_releases': 1,
                'background_processing': True,
                'expected_releases': release_count,
            },
        )

    return gateway_ok(
        store_key, f'{store_key}/dryer/{mid}', str(minutes), resp.status_code,
        f'Dryer {mid} started for {minutes} min',
        {'machine': mid, 'minutes': minutes, 'releases': release_count},
    )


def gateway_control_ac(store: str, temperature: str):
    temp = str(temperature).lower()
    if temp not in AC_TEMPERATURES:
        return err_parametro_invalido()

    store_key = normalize_store_id(store)
    device_path = AC_DEVICE_PATHS[temp]
    request_id = getattr(request, 'request_id', f"ac_{int(time.time() * 1000)}")
    logger.info(
        f"[{request_id}] {Fore.CYAN}❄️ AC request store={store_key.upper()} temp={temp}{Style.RESET_ALL}"
    )
    result = send_ac_command(device_path, temp)
    if not result.get('success'):
        logger.warning(
            f"[{request_id}] {Fore.YELLOW}⚠️ AC failed: "
            f"{result.get('error') or result.get('status_code')}{Style.RESET_ALL}"
        )
        return err_nao_respondeu('O ar-condicionado')

    description = 'AC turned off' if temp == 'off' else f'AC set to {temp}°C'
    return gateway_ok(
        store_key,
        f'{store_key}/ac',
        temp,
        result.get('status_code'),
        description,
        {'device_path': device_path, 'url': result.get('url')},
    )


def gateway_doser_type(store: str, machine: str, cmd_type: str):
    mid = validate_doser_id(machine)
    if not mid:
        return err_equipamento_invalido()

    endpoint = DOSER_TYPE_PATHS.get(cmd_type)
    if not endpoint:
        return err_parametro_invalido()

    store_key = normalize_store_id(store)
    result = send_doser_http(mid, endpoint)
    if result.get('status_code') != 200:
        return err_falha_acao('A dosadora')

    return gateway_ok(
        store_key, f'{store_key}/doser/{mid}', cmd_type, result.get('status_code'),
        f'Doser {mid} — {cmd_type}',
        {'machine': mid, 'type': cmd_type, 'url': result.get('url')},
    )


def gateway_status_payload(store: str, machine: str | None, device_type: str | None):
    store_key = normalize_store_id(store)
    if not machine and not device_type:
        raw = attach_network_summary(build_network_status_all())
        data = filter_network_status_for_frontend(raw)
        data['store'] = store_key
        data['machines'] = filter_machines_for_frontend(get_store_machines_list(), raw)
        return gateway_json(data, 200)

    if device_type == 'washer' or (machine and is_washer_id(machine) and not device_type):
        mid = normalize_machine_id(machine)
        if not is_washer_id(mid):
            return err_equipamento_invalido()
        payload = build_device_status_payload(mid, 'washer')
        payload['store'] = store_key
        return gateway_json(payload, 200 if payload['online'] else 400)

    if device_type == 'dryer' or (machine and is_dryer_id(machine) and not device_type):
        mid = normalize_machine_id(machine)
        if not is_dryer_id(mid):
            return err_equipamento_invalido()
        payload = build_device_status_payload(mid, 'dryer')
        payload['store'] = store_key
        return gateway_json(payload, 200 if payload['online'] else 400)

    if device_type == 'doser' or (machine and is_doser_id(machine) and not device_type):
        mid = validate_doser_id(machine)
        if not mid:
            return err_equipamento_invalido()
        payload = build_device_status_payload(mid, 'doser')
        payload['store'] = store_key
        return gateway_json(payload, 200 if payload['online'] else 400)

    if device_type == 'ac' or (not machine and device_type == 'ac'):
        online = device_online(AC_ID, 'ac')
        payload = {
            'store': store_key,
            'device_type': 'ac',
            'id': AC_ID,
            'ip': AC_IP,
            'online': online,
            'status': 'online' if online else 'offline',
        }
        return gateway_json(payload, 200 if online else 400)

    if machine:
        mid = normalize_machine_id(machine)
        types = list_device_types_for_id(mid)
        if len(types) > 1:
            payload = build_device_statuses_for_id(mid, types)
            payload['store'] = store_key
            return gateway_json(payload, 200 if payload['online'] else 400)

    return err_comando_invalido()


# ══════════════════════════════════════════════════════
# API Gateway LAV60 — mesmo modelo do main.py (HTTP local)
# ══════════════════════════════════════════════════════

@app.route('/<store>/washer/<machine>', methods=['POST'])
def gateway_washer(store: str, machine: str):
    body = parse_json_body_dict()
    am = body.get('am')
    return gateway_release_washer(store, machine, am)


@app.route('/<store>/dryer/<machine>', methods=['POST'])
def gateway_dryer(store: str, machine: str):
    body = parse_json_body_dict()
    minutes = body.get('minutes')
    if minutes is None:
        return err_dados_incompletos()
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        return err_parametro_invalido()
    return gateway_release_dryer(store, machine, minutes)


@app.route('/<store>/ac', methods=['POST'])
def gateway_ac(store: str):
    body = parse_json_body_dict()
    temperature = body.get('temperature')
    if temperature is None:
        return err_dados_incompletos()
    return gateway_control_ac(store, str(temperature))


@app.route('/<store>/doser/<machine>', methods=['POST'])
def gateway_doser(store: str, machine: str):
    body = parse_json_body_dict()
    cmd_type = body.get('type')
    if not cmd_type:
        return err_dados_incompletos()
    return gateway_doser_type(store, machine, str(cmd_type).strip())


@app.route('/<store>/doser/<machine>/amaciante', methods=['POST'])
def gateway_doser_amaciante(store: str, machine: str):
    mid = validate_doser_id(machine)
    if not mid:
        return err_equipamento_invalido()
    body = parse_json_body_dict()
    if body.get('endpoint'):
        endpoint = str(body['endpoint']).strip()
        if not endpoint.startswith('/'):
            endpoint = f'/{endpoint}'
    elif body.get('number') is not None:
        endpoint = AMACIANTE_NUMBER_PATHS.get(int(body['number']))
        if not endpoint:
            return err_parametro_invalido()
    else:
        return err_dados_incompletos()

    store_key = normalize_store_id(store)
    result = send_doser_http(mid, endpoint)
    if result.get('status_code') != 200:
        return err_falha_acao('A dosadora')
    return gateway_ok(
        store_key, f'{store_key}/doser/{mid}/amaciante', endpoint.lstrip('/'), result.get('status_code'),
        f'Doser {mid} — amaciante',
        {'machine': mid, 'endpoint': endpoint},
    )


@app.route('/<store>/doser/<machine>/bomba', methods=['POST'])
def gateway_doser_bomba(store: str, machine: str):
    mid = validate_doser_id(machine)
    if not mid:
        return err_equipamento_invalido()
    body = parse_json_body_dict()
    pump = body.get('pump')
    if pump not in (1, 2, 3):
        return err_parametro_invalido()
    endpoint = f'/rele{int(pump)}on'
    store_key = normalize_store_id(store)
    result = send_doser_http(mid, endpoint)
    if result.get('status_code') != 200:
        return err_falha_acao('A dosadora')
    return gateway_ok(
        store_key, f'{store_key}/doser/{mid}/bomba', str(pump), result.get('status_code'),
        f'Doser {mid} — bomba {pump}',
        {'machine': mid, 'pump': pump},
    )


@app.route('/<store>/doser/<machine>/consulta', methods=['GET'])
def gateway_doser_consulta(store: str, machine: str):
    mid = validate_doser_id(machine)
    if not mid:
        return err_equipamento_invalido()

    store_key = normalize_store_id(store)
    consultas = (
        ('sabao', '/consultasb01'),
        ('floral', '/consultaam01'),
        ('sport', '/consultaam02'),
    )
    tempos = {}
    for name, path in consultas:
        result = send_doser_http(mid, path)
        if result.get('status_code') != 200:
            return err_falha_acao('A dosadora')
        parsed = parse_doser_tempo_response(result.get('response', ''))
        if parsed is None:
            return err_nao_respondeu('A dosadora')
        tempos[name] = parsed

    return gateway_json({'store': store_key, 'machine': mid, 'tempos': tempos}, 200)


def gateway_doser_settime_impl(store: str, machine: str, rele: int, seconds: float):
    mid = validate_doser_id(machine)
    if not mid:
        return err_equipamento_invalido()
    if rele not in (1, 2, 3):
        return err_parametro_invalido()
    if not (0 < float(seconds) <= 3600):
        return err_parametro_invalido()

    payload = f'{rele}:{format_seconds_payload(seconds)}'
    endpoint = build_doser_settime_path(rele, seconds)
    store_key = normalize_store_id(store)
    result = send_doser_http(mid, endpoint)
    if result.get('status_code') != 200:
        return err_falha_acao('A dosadora')
    return gateway_ok(
        store_key, f'{store_key}/doser/{mid}/settime', payload, result.get('status_code'),
        f'Doser {mid} — settime rele {rele} ({seconds}s)',
        {'machine': mid, 'rele': rele, 'seconds': seconds, 'device_path': endpoint},
    )


@app.route('/<store>/doser/<machine>/settime', methods=['POST'])
def gateway_doser_settime(store: str, machine: str):
    body = parse_json_body_dict()
    rele = body.get('rele')
    seconds = body.get('seconds')
    if rele is None or seconds is None:
        return err_dados_incompletos()
    try:
        return gateway_doser_settime_impl(store, machine, int(rele), float(seconds))
    except (TypeError, ValueError):
        return err_parametro_invalido()


@app.route('/<store>/doser/<machine>/settime/sabao', methods=['POST'])
def gateway_doser_settime_sabao(store: str, machine: str):
    body = parse_json_body_dict()
    seconds = body.get('seconds')
    if seconds is None:
        return err_dados_incompletos()
    try:
        return gateway_doser_settime_impl(store, machine, 1, float(seconds))
    except (TypeError, ValueError):
        return err_parametro_invalido()


@app.route('/<store>/doser/<machine>/settime/floral', methods=['POST'])
def gateway_doser_settime_floral(store: str, machine: str):
    body = parse_json_body_dict()
    seconds = body.get('seconds')
    if seconds is None:
        return err_dados_incompletos()
    try:
        return gateway_doser_settime_impl(store, machine, 2, float(seconds))
    except (TypeError, ValueError):
        return err_parametro_invalido()


@app.route('/<store>/doser/<machine>/settime/sport', methods=['POST'])
def gateway_doser_settime_sport(store: str, machine: str):
    body = parse_json_body_dict()
    seconds = body.get('seconds')
    if seconds is None:
        return err_dados_incompletos()
    try:
        return gateway_doser_settime_impl(store, machine, 3, float(seconds))
    except (TypeError, ValueError):
        return err_parametro_invalido()


@app.route('/<store>/led/on', methods=['POST'])
@app.route('/<store>/led/off', methods=['POST'])
@app.route('/<store>/led', methods=['POST'])
def gateway_led_not_available(store: str):
    return gateway_error('Controle de LED indisponível nesta loja.', 501)


@app.route('/<store>/doser/<machine>/dosagem', methods=['POST'])
def gateway_doser_dosagem(store: str, machine: str):
    body = parse_json_body_dict()
    endpoint = body.get('endpoint')
    if not endpoint:
        return err_dados_incompletos()
    return gateway_doser_type(store, machine, str(endpoint).strip())


@app.route('/<store>/doser/<machine>/device-status', methods=['GET'])
def gateway_doser_device_status(store: str, machine: str):
    mid = validate_doser_id(machine)
    if not mid:
        return err_equipamento_invalido()
    doser_ip = get_device_ip(mid, 'doser')
    online = doser_online(doser_ip) if doser_ip else False
    return gateway_json({
        'store': normalize_store_id(store),
        'machine': mid,
        'online': online,
    }, 200)


@app.route('/<store>/status', methods=['GET'])
def gateway_status_all(store: str):
    return gateway_status_payload(store, None, None)


@app.route('/<store>/status/washer/<machine>', methods=['GET'])
def gateway_status_washer(store: str, machine: str):
    return gateway_status_payload(store, machine, 'washer')


@app.route('/<store>/status/dryer/<machine>', methods=['GET'])
def gateway_status_dryer(store: str, machine: str):
    return gateway_status_payload(store, machine, 'dryer')


@app.route('/<store>/status/doser/<machine>', methods=['GET'])
def gateway_status_doser(store: str, machine: str):
    return gateway_status_payload(store, machine, 'doser')


@app.route('/<store>/status/ac', methods=['GET'])
def gateway_status_ac(store: str):
    return gateway_status_payload(store, None, 'ac')


@app.route('/<store>/devices', methods=['GET'])
def gateway_devices(store: str):
    ambiguous = get_ambiguous_device_ids()
    return gateway_json({
        'store': normalize_store_id(store),
        'washers': get_washer_map(),
        'dryers': get_dryer_map(),
        'dosers': get_doser_map(),
        'ac': {AC_ID: AC_IP},
        'doser_types': list(DOSER_TYPE_PATHS.keys()),
        'relay_products': DOSADORA_RELAY_ENDPOINTS,
        'ambiguous_ids': ambiguous,
        'machines': get_store_machines_list(),
        'timestamp': datetime.now().isoformat(),
    }, 200)


@app.route('/api/devices', methods=['GET'])
def api_devices():
    """GET — catálogo de equipamentos e IPs configurados."""
    ambiguous = get_ambiguous_device_ids()
    return jsonify({
        'washers': get_washer_map(),
        'dryers': get_dryer_map(),
        'dosers': get_doser_map(),
        'ac': {AC_ID: AC_IP},
        'machines': get_store_machines_list(),
        'softener_types': VALID_SOFTENERS,
        'dosage_types': VALID_DOSAGES,
        'doser_relay_products': DOSADORA_RELAY_ENDPOINTS,
        'dryer_timers': list(DRYER_TIMER_RELEASES.keys()),
        'ambiguous_ids': ambiguous,
        'timestamp': datetime.now().isoformat(),
    }), 200

@app.route('/api/network-status', methods=['GET'])
@app.route('/network-status', methods=['GET'])
@app.route('/ping-status', methods=['GET'])
def network_status():
    """
    Verificação de rede no padrão mqtt-esp8266.ino (ping/all e ping/{tipo}/{id}).
    - Sem parâmetros: retorna washers, dryers, ac e dosers
    - ?machine=654: retorna todos os equipamentos com esse ID (ex.: washer + doser)
    - ?machine=654&type=washer: retorna um equipamento específico
    """
    request_id = f"network_status_{int(time.time() * 1000)}"
    machine_id = request.args.get('machine', '').strip()
    device_type = request.args.get('type', '').strip()

    if not machine_id:
        logger.info(f"[{request_id}] Network status (all devices) requested")
        raw = attach_network_summary(build_network_status_all())
        data = filter_network_status_for_frontend(raw)
        return jsonify(data), 200

    resolved = resolve_device(machine_id, device_type)
    if resolved:
        mid, dtype = resolved
        logger.info(f"[{request_id}] Network status requested for {dtype}/{mid}")
        payload = build_device_status_payload(mid, dtype)
        status_code = 200 if payload['online'] else 400
        return jsonify(payload), status_code

    mid = normalize_machine_id(machine_id)
    matching_types = list_device_types_for_id(mid)

    if not matching_types:
        return jsonify({
            'error': f'ID inválido: {machine_id}',
            'valid_ids': {
                'washers': get_washer_ids(),
                'dryers': get_dryer_ids(),
                'dosers': get_doser_ids(),
                'ac': AC_ID,
            },
            'timestamp': datetime.now().isoformat(),
        }), 400

    logger.info(f"[{request_id}] Network status requested for ambiguous id {mid}: {matching_types}")
    payload = build_device_statuses_for_id(mid, matching_types)
    status_code = 200 if payload['online'] else 400
    return jsonify(payload), status_code


@app.route('/api/status', methods=['GET'])
def api_status():
    """Alias de compatibilidade para /api/network-status?machine=..."""
    return network_status()

@app.route('/api/health', methods=['GET'])
def api_health():
    """
    Endpoint API de health check para monitoramento
    """
    return health_check()

@app.route('/health', methods=['GET'])
def health_check():
    """Endpoint de health check"""
    response_data = {"status": "ok", "service": "proxy-server"}
    return jsonify(response_data), 200


# ══════════════════════════════════════════════════════
# API do agente (alimenta o frontend independente)
# ══════════════════════════════════════════════════════

def agent_public_base_url() -> str:
    """URL pública do agente — HTTPS em túnel (evita 301 que quebra CORS no browser)."""
    host = (request.host or '').lower()
    is_local = (
        host.startswith('localhost')
        or host.startswith('127.0.0.1')
        or host.startswith('192.168.')
        or host.startswith('10.')
    )
    if is_local:
        return request.url_root.rstrip('/')
    forwarded = (request.headers.get('X-Forwarded-Proto') or '').split(',')[0].strip().lower()
    scheme = forwarded if forwarded in ('http', 'https') else 'https'
    if scheme == 'http':
        scheme = 'https'
    return f'{scheme}://{request.host}'.rstrip('/')


@app.route('/api/agent/config', methods=['GET'])
def agent_api_config():
    """Metadados desta loja para o frontend (sem segredos)."""
    with network_status_lock:
        cached_raw = dict(last_network_status) if last_network_status else None
    cached = filter_network_status_for_frontend(cached_raw) if cached_raw else None
    return jsonify({
        'store': env_store_id().lower(),
        'agent_url': agent_public_base_url(),
        'token_required': bool(API_TOKEN),
        'network_check_interval': NETWORK_CHECK_INTERVAL,
        'devices': device_catalog(cached_raw),
        'machines': filter_machines_for_frontend(get_store_machines_list(), cached_raw),
        'washer_am_options': list(VALID_WASHER_AM),
        'dryer_minutes': list(DRYER_TIMER_RELEASES.keys()),
        'ac_temperatures': list(AC_TEMPERATURES),
        'doser_types': list(DOSER_TYPE_PATHS.keys()),
        'hide_when_offline': [{'type': t, 'id': i} for t, i in sorted(FRONTEND_HIDE_WHEN_OFFLINE)],
        'last_network_check': cached,
    }), 200


@app.route('/', methods=['GET'])
def index():
    """
    Endpoint raiz
    """
    request_id = f"index_{int(time.time() * 1000)}"
    store_id = env_store_id()
    
    logger.info(f"[{request_id}] Index page requested")
    logger.info(f"[{request_id}] Store ID from environment: {store_id}")
    
    response_data = {
        "service": "Cloudflare Tunnel Proxy — LAV60 Gateway",
        "store_id": store_id,
        "documentation": "API_ENDPOINTS.md",
        "frontend": "frontend/ — painel (scripts/serve.ps1, porta 3000)",
        "agent_api": "/api/agent/config",
        "api_convention": {
            "POST": "Ações — washer, dryer, doser, ac (corpo JSON)",
            "GET": "Consultas — status, devices, health",
            "auth": "Header X-Token quando API_TOKEN estiver definido",
        },
        "endpoints": {
            "POST /{store}/washer/{machine}": "Libera lavadora (body opcional: am=am01-1|am01-2|am02-1|am02-2)",
            "POST /{store}/dryer/{machine}": "Libera secadora (body: minutes=15|30|45)",
            "POST /{store}/ac": "Ar-condicionado (body: temperature=18|22|off)",
            "POST /{store}/doser/{machine}": "Comando dosadora (body: type=rele1on|am01-1|...)",
            "POST /{store}/doser/{machine}/amaciante": "Softener 1-3",
            "POST /{store}/doser/{machine}/dosagem": "Dosagem am01/am02",
            "POST /{store}/doser/{machine}/bomba": "Bomba (body: pump=1|2|3)",
            "GET /{store}/doser/{machine}/consulta": "Consulta tempos sabão/floral/sport",
            "POST /{store}/doser/{machine}/settime": "Ajuste tempo relé",
            "GET /{store}/status": "Status de rede (todos os dispositivos)",
            "GET /{store}/devices": "Catálogo de equipamentos",
            "GET /api/network-status": "Alias legado de status (?machine=&type=)",
            "GET /api/health": "Health check",
            "GET /debug": "Diagnóstico do sistema",
            "GET /tunnel-status": "Status do túnel Cloudflare",
        },
        "examples": {
            "release_washer": {
                "method": "POST",
                "path": f"/{store_id.lower()}/washer/321",
                "headers": {"X-Token": "..."},
            },
            "release_dryer": {
                "method": "POST",
                "path": f"/{store_id.lower()}/dryer/210",
                "body": {"minutes": 30},
            },
            "doser_relay": {
                "method": "POST",
                "path": f"/{store_id.lower()}/doser/321",
                "body": {"type": "rele1on"},
            },
            "network_status": {
                "method": "GET",
                "path": f"/{store_id.lower()}/status",
            },
        },
        "device_catalog": device_catalog(),
        "machine_mapping": {
            "washers": get_washer_map(),
            "dosers": get_doser_map(),
            "dryers": get_dryer_map(),
            "ac": {AC_ID: AC_IP},
            "source": "lav60_api" if get_store_machines_snapshot() else "fixed_fallback",
        },
        "doser_info": {
            "softener_types": VALID_SOFTENERS,
            "dosage_types": VALID_DOSAGES,
            "relay_products": DOSADORA_RELAY_ENDPOINTS,
            "configure_endpoints": {
                "FLORAL_SIMPLES": "/am01-1",
                "FLORAL_DUPLA": "/am01-2",
                "SPORT_SIMPLES": "/am02-1",
                "SPORT_DUPLA": "/am02-2",
                "SEM_AMACIANTE": "/softener0",
                "DISABLE": "/softener0",
            },
        },
    }
    
    logger.info(f"[{request_id}] Index page response: {response_data}")
    return jsonify(response_data), 200

def ensure_cloudflared_installed() -> bool:
    """
    Verifica se o cloudflared está instalado. Se não estiver e estivermos no Windows,
    tenta instalar via winget de forma não interativa. Retorna True se disponível.
    """
    global _cloudflared_path
    # 1) Preparar pasta .cloudflared/cert.pem
    try:
        ensure_user_cloudflared_cert()
    except Exception:
        pass

    # 2) Tentar usar binário local baixado ou cloudflared do sistema
    try:
        cf = resolve_cloudflared_path()
        r = subprocess.run([cf, 'version'], capture_output=True, text=True, timeout=6)
        if r.returncode == 0:
            _cloudflared_path = cf
            logger.info("cloudflared detectado: %s", r.stdout.strip().splitlines()[0] if r.stdout else "ok")
            return True
    except Exception:
        pass

    # 3) Se não encontrou, baixar binário (somente Windows)
    if os.name != 'nt':
        logger.error("cloudflared não encontrado e download automático só é suportado no Windows. Instale manualmente.")
        return False

    logger.info("cloudflared não encontrado. Baixando binário oficial...")
    try:
        cf_path = download_cloudflared_binary()
        r = subprocess.run([cf_path, 'version'], capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            _cloudflared_path = cf_path
            logger.info("cloudflared disponível após download: %s", r.stdout.strip().splitlines()[0] if r.stdout else "ok")
            return True
    except Exception as e:
        logger.error("Falha ao baixar/validar cloudflared: %s", str(e))
        return False

    logger.error("cloudflared ainda não disponível após tentativa de download.")
    return False


def ensure_env_alignment() -> dict:
    """
    Lê variáveis de ambiente existentes sem criar/persistir novas.
    Regras: TUNNEL_NAME (se definido) senão STORE_ID (obrigatório).
    """
    tunnel_name_env = _windows_env('TUNNEL_NAME')
    store_env = require_store_id()
    if tunnel_name_env:
        return {'target': tunnel_name_env.upper(), 'source': 'TUNNEL_NAME'}
    return {'target': store_env, 'source': 'STORE_ID'}

# Utilitário para resolver caminhos de recursos (funciona empacotado ou em dev)
def _bundled_path(relative: str) -> Path | None:
    if is_frozen():
        p = Path(getattr(sys, '_MEIPASS', '')) / relative
        return p if p.exists() else None
    if relative.endswith('.yml'):
        p = config_dir() / relative
        return p if p.exists() else None
    p = project_root() / relative
    return p if p.exists() else None


def resolve_config_path() -> str:
    """config.yml gravável em %USERPROFILE%\\.lav60\\ (criado na primeira execução)."""
    dest = app_data_dir() / 'config.yml'
    if dest.exists():
        return str(dest)
    for template_name in ('config.template.yml', 'config.yml'):
        src = _bundled_path(template_name)
        if src:
            shutil.copy2(src, dest)
            return str(dest)
        dev = config_dir() / template_name
        if dev.exists():
            shutil.copy2(dev, dest)
            return str(dest)
    dest.write_text(
        'tunnel: pending\nprotocol: http2\ncredentials-file: pending\n\n'
        'ingress:\n  - service: http_status:404\n',
        encoding='utf-8',
    )
    return str(dest)


def resolve_resource(relative: str) -> str:
    if relative == 'config.yml':
        return resolve_config_path()
    script_dir = Path(__file__).resolve().parent
    bundled_dir = Path(getattr(sys, '_MEIPASS', script_dir))
    exe_dir = Path(sys.executable).resolve().parent if is_frozen() else None
    cfg_dir = config_dir()
    candidates = [
        (exe_dir / relative) if exe_dir else None,
        app_data_dir() / relative,
        Path.cwd() / relative,
        cfg_dir / relative if relative.endswith('.yml') else None,
        project_root() / relative,
        script_dir / relative,
        bundled_dir / relative,
    ]
    for c in candidates:
        if c and c.exists():
            return str(c)
    if relative.endswith('.yml'):
        return resolve_config_path()
    if exe_dir:
        return str(exe_dir / relative)
    return str(script_dir / relative)

def get_cloudflared_download_dir() -> Path:
    return Path.home() / 'cloudflared-bin'

def get_cloudflared_download_path() -> Path:
    return get_cloudflared_download_dir() / 'cloudflared.exe'

def download_cloudflared_binary() -> str:
    """Baixa o cloudflared para %USERPROFILE%\\cloudflared-bin\\cloudflared.exe e retorna o caminho."""
    url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    dest_dir = get_cloudflared_download_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = get_cloudflared_download_path()
    # Download via requests com stream
    resp = requests.get(url, timeout=60, stream=True)
    resp.raise_for_status()
    with open(dest_path, 'wb') as f:
        for chunk in resp.iter_content(chunk_size=1024 * 128):
            if chunk:
                f.write(chunk)
    return str(dest_path)

def resolve_cloudflared_path() -> str:
    """Retorna o caminho do executável cloudflared a ser usado."""
    global _cloudflared_path
    if _cloudflared_path:
        return _cloudflared_path
    local = get_cloudflared_download_path()
    if local.exists():
        return str(local)
    return 'cloudflared'

def run_cloudflared(args: list[str], timeout: int = 10) -> subprocess.CompletedProcess:
    cmd = [resolve_cloudflared_path()] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

def ensure_user_cloudflared_cert() -> None:
    """Cria %USERPROFILE%\\.cloudflared\\cert.pem a partir de ORIGIN_CERTIFICATE."""
    dest_dir = Path.home() / '.cloudflared'
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / 'cert.pem'
    try:
        with open(dest_path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(ORIGIN_CERTIFICATE.strip() + '\n')
        logger.info("cert.pem escrito em %s a partir de ORIGIN_CERTIFICATE", dest_path)
    except Exception as e:
        logger.warning("Falha ao escrever cert.pem: %s", str(e))


def get_cloudflared_version() -> str:
    try:
        r = run_cloudflared(['version'], timeout=5)
        if r.returncode == 0:
            line0 = (r.stdout or '').strip().splitlines()[0] if r.stdout else ''
            return line0 or 'ok'
    except Exception:
        pass
    return 'not found'


def get_tunnel_status(tunnel_ref: str | None = None) -> dict:
    """Retorna informações do tunnel (conexões ativas, mensagem)."""
    try:
        args = ['tunnel', 'info']
        if tunnel_ref:
            args.append(tunnel_ref)
        else:
            args.append(tunnel_target_name())
        r = run_cloudflared(args, timeout=8)
        out = (r.stdout or '') + ("\n" + r.stderr if r.stderr else '')
        has_connections = ('does not have any active connection' not in out.lower()) and ('CONNECTOR ID' in out)
        # contar locais 'Registered tunnel connection' ou locais na tabela
        connections = 0
        for line in out.splitlines():
            if 'Registered tunnel connection' in line or 'location=' in line:
                connections += 1
        return {
            'ok': r.returncode == 0,
            'has_connections': has_connections,
            'connections_observed': connections,
            'raw': out.strip()[:2000]
        }
    except Exception as e:
        return {'ok': False, 'has_connections': False, 'connections_observed': 0, 'raw': str(e)}


def check_external_subdomain(store_id: str) -> dict:
    """Testa o subdomínio via Cloudflare fazendo GET em /health."""
    try:
        host = store_hostname(store_id)
        url = f"https://{host}/health?_={int(time.time() * 1000)}"
        resp = requests.get(url, timeout=6, headers={'Cache-Control': 'no-cache'})
        return {'host': host, 'url': url, 'status_code': resp.status_code, 'ok': resp.ok}
    except Exception as e:
        return {'host': store_hostname(store_id), 'url': None, 'status_code': None, 'ok': False, 'error': str(e)}


def verify_tunnel_reaches_local(store_id: str | None = None, timeout: float = 8) -> dict:
    """Confirma que o subdomínio roteia tráfego para este processo Flask (não só cache/ outro conector)."""
    global last_inbound_request_at
    sid = store_id or env_store_id()
    before = last_inbound_request_at or 0.0
    host = store_hostname(sid)
    probe = int(time.time() * 1000)
    url = f'https://{host}/health?_probe={probe}'
    result: dict = {
        'host': host,
        'url': url,
        'external_ok': False,
        'local_hit': False,
        'ok': False,
    }
    try:
        resp = requests.get(url, timeout=timeout, headers={'Cache-Control': 'no-cache'})
        result['external_ok'] = resp.ok
        result['status_code'] = resp.status_code
        deadline = time.time() + 2.5
        while time.time() < deadline:
            if last_inbound_request_at and last_inbound_request_at > before:
                result['local_hit'] = True
                break
            time.sleep(0.05)
        result['ok'] = bool(result['external_ok'] and result['local_hit'])
    except Exception as e:
        result['error'] = str(e)
    return result


def read_config_metadata(config_path: str) -> dict:
    """Extrai metadados simples do config.yml (id, credenciais e hostnames)."""
    info = {'tunnel_id': None, 'credentials_file': None, 'hostnames': [], 'has_wildcard': False}
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            content = f.read()
        m = re.search(r'^\s*tunnel:\s*([^\s#]+)', content, re.M)
        if m:
            info['tunnel_id'] = m.group(1).strip()
        m = re.search(r'^\s*credentials-file:\s*(.+)$', content, re.M)
        if m:
            info['credentials_file'] = m.group(1).strip()
        for hm in re.finditer(r'^\s*-\s*hostname:\s*"?([^"\n]+)"?', content, re.M):
            host = hm.group(1).strip()
            info['hostnames'].append(host)
        info['has_wildcard'] = any(h.startswith('*.') for h in info['hostnames'])
    except Exception:
        pass
    return info


def find_tunnel_id(name: str) -> str | None:
    """Consulta o ID de um túnel pelo nome usando 'cloudflared tunnel list'."""
    try:
        r = run_cloudflared(['tunnel', 'list'], timeout=10)
        if r.returncode == 0 and r.stdout:
            for line in r.stdout.splitlines():
                # Espera formato: <ID>  <NAME>  <CREATED> ...
                parts = line.split()
                if len(parts) >= 2 and parts[1] == name:
                    return parts[0]
    except Exception:
        pass
    return None


def ensure_tunnel_and_config(tunnel_name: str, config_path: str, rewrite_config: bool = True) -> str | None:
    """
    - Garante que exista um túnel com nome tunnel_name (cria se faltar)
    - Ajusta o config.yml para usar o TunnelID/credentials desse túnel
    - Garante rota DNS <tunnel_name>.powpay.com.br
    Retorna caminho do config ajustado (ou None se não alterado)
    """
    # 1) Obter ou criar túnel
    tid = find_tunnel_id(tunnel_name)
    if not tid:
        # criar túnel
        r = run_cloudflared(['tunnel', 'create', tunnel_name], timeout=30)
        if r.returncode != 0:
            raise RuntimeError(f"Falha ao criar túnel {tunnel_name}: {r.stderr}")
        # Após criar, ler novamente
        tid = find_tunnel_id(tunnel_name)
        if not tid:
            raise RuntimeError("Não foi possível obter o TunnelID após criação")

    # 2) Apontar DNS para <tunnel_name>.powpay.com.br
    hostname = store_hostname(tunnel_name)
    run_cloudflared(['tunnel', 'route', 'dns', tunnel_name, hostname], timeout=20)

    # 2.1) Garantir que o arquivo de credenciais exista neste PC (baixar se faltar)
    cred_file = str(Path.home() / '.cloudflared' / f'{tid}.json')
    if not Path(cred_file).exists():
        try:
            dl = run_cloudflared(['tunnel', 'token', '--cred-file', cred_file, tid], timeout=30)
            if dl.returncode == 0 and Path(cred_file).exists():
                logger.info("Credenciais baixadas para %s", cred_file)
            else:
                logger.warning("Falha ao baixar credenciais via 'tunnel token': %s", (dl.stderr or dl.stdout))
        except Exception as e:
            logger.warning("Erro ao baixar credenciais: %s", str(e))

    # 3) Opcionalmente, reescrever config.yml para este túnel
    if not rewrite_config:
        return None
    try:
        new_config = (
            f"tunnel: {tid}\n"
            f"protocol: http2\n"
            f"credentials-file: {cred_file}\n\n"
            f"ingress:\n"
            f"  - hostname: {hostname}\n"
            f"    service: http://localhost:8080\n"
            f"  - service: http_status:404\n"
        )
        Path(config_path).write_text(new_config, encoding='utf-8')
        logger.info("config.yml reescrito para túnel %s (ID=%s), hostname %s", tunnel_name, tid, hostname)
        return config_path
    except Exception as e:
        logger.warning("Falha ao reescrever config.yml: %s", str(e))
        return None


# Controle de provisionamento automático em background
_provisioning_lock = threading.Lock()
_provisioning_in_progress: set[str] = set()


def queue_auto_provision_if_needed(target_store: str) -> None:
    """Se não existe um túnel com o nome target_store, provisiona em background.
    Não troca o túnel atual automaticamente; apenas garante que cert/config/DNS existam.
    """
    if not target_store:
        return
    # Já existe?
    if find_tunnel_id(target_store):
        return
    with _provisioning_lock:
        if target_store in _provisioning_in_progress:
            return
        _provisioning_in_progress.add(target_store)

    def _worker():
        try:
            logger.info("AUTO-PROVISION: iniciando criação de túnel/DNS para %s", target_store)
            cfg = resolve_resource('config.yml')
            ensure_tunnel_and_config(target_store, cfg)
            logger.info("AUTO-PROVISION: concluído para %s. Reinicie o processo para usar o novo túnel.", target_store)
        except Exception as e:
            logger.error("AUTO-PROVISION: falhou para %s: %s", target_store, str(e))
        finally:
            with _provisioning_lock:
                _provisioning_in_progress.discard(target_store)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()

def start_tunnel():
    """
    Inicia o Cloudflare Tunnel automaticamente
    """
    global tunnel_process
    try:
        # Certificar que o cloudflared está disponível antes de iniciar
        if not ensure_cloudflared_installed():
            logger.error(f"{Fore.RED}❌ Cannot start tunnel without cloudflared{Style.RESET_ALL}")
            return
        config_path = resolve_resource('config.yml')
        
        log_tunnel_info("starting")
        
        # Determinar alvo: TUNNEL_NAME ou STORE_ID (obrigatório)
        target_name = tunnel_target_name()

        logger.info(f"{Fore.CYAN}🎯 Target: {Fore.WHITE}{target_name}{Style.RESET_ALL}")

        # Garantir/ajustar túnel, DNS e reescrever config.yml para o alvo
        try:
            cfg_updated = ensure_tunnel_and_config(target_name, config_path, rewrite_config=True)
            if cfg_updated:
                config_path = cfg_updated
        except Exception as e:
            logger.warning(f"{Fore.YELLOW}⚠️ Failed to adjust config/DNS for {target_name}: {str(e)}{Style.RESET_ALL}")

        cmd = [resolve_cloudflared_path(), 'tunnel', '--config', config_path, 'run']
        if target_name:
            cmd.append(target_name)
            logger.info(f"{Fore.CYAN}🚀 Using TARGET={target_name} to start tunnel{Style.RESET_ALL}")

        # PIPE sem leitura trava o cloudflared no Windows — gravar em arquivo
        global _tunnel_log_file
        log_path = cloudflared_log_path()
        _tunnel_log_file = open(log_path, 'a', encoding='utf-8', buffering=1)
        _tunnel_log_file.write(f"\n--- tunnel start {datetime.now().isoformat()} pid pending ---\n")
        _tunnel_log_file.flush()
        tunnel_process = subprocess.Popen(
            cmd,
            stdout=_tunnel_log_file,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        )
        _tunnel_log_file.write(f"--- cloudflared pid {tunnel_process.pid} ---\n")
        _tunnel_log_file.flush()

        log_process_info("Cloudflare Tunnel", "Started", tunnel_process.pid)
        logger.info(f"{Fore.CYAN}📄 cloudflared log: {Fore.WHITE}{log_path}{Style.RESET_ALL}")
        
    except Exception as e:
        logger.error(f"{Fore.RED}❌ Error starting tunnel: {str(e)}{Style.RESET_ALL}")


def build_debug_snapshot() -> dict:
    store_id = env_store_id()
    store_source = 'windows_registry' if os.name == 'nt' else 'environment'
    config_path = resolve_resource('config.yml')
    cloudflared_ver = get_cloudflared_version()
    tunnel_name_env = _windows_env('TUNNEL_NAME') or None
    tunnel = get_tunnel_status(tunnel_name_env)
    sub = check_external_subdomain(store_id)
    cfg_meta = read_config_metadata(config_path)
    with network_status_lock:
        cached_network = dict(last_network_status) if last_network_status else None
    return {
        'service': 'Cloudflare Tunnel Proxy',
        'store_id': store_id,
        'store_source': store_source,
        'target_server': TARGET_SERVER,
        'config_path': config_path,
        'config_meta': cfg_meta,
        'tunnel_name_env': tunnel_name_env,
        'cloudflared_version': cloudflared_ver,
        'tunnel': tunnel,
        'subdomain_check': sub,
        'tunnel_process_running': bool(tunnel_process and (tunnel_process.poll() is None)),
        'network_monitoring': {
            'interval_seconds': NETWORK_CHECK_INTERVAL,
            'last_check': cached_network,
        },
    }


@app.route('/debug', methods=['GET'])
def debug_info():
    request_id = f"debug_{int(time.time() * 1000)}"
    logger.info(f"[{request_id}] Debug info requested")
    
    debug_data = build_debug_snapshot()
    logger.info(f"[{request_id}] Debug data generated: {len(str(debug_data))} characters")
    
    return jsonify(debug_data), 200

@app.route('/api/tunnel-status', methods=['GET'])
def api_tunnel_status():
    """
    Endpoint API para status do Cloudflare Tunnel
    """
    return tunnel_status()

@app.route('/tunnel-status', methods=['GET'])
def tunnel_status():
    """
    Endpoint para verificar o status atual do tunnel
    """
    request_id = f"tunnel_status_{int(time.time() * 1000)}"
    logger.info(f"[{request_id}] Tunnel status check requested")
    
    try:
        # Obter informações do tunnel
        tunnel_name_env = os.environ.get('TUNNEL_NAME')
        tunnel_info = get_tunnel_status(tunnel_name_env)
        
        # Obter informações do subdomínio
        store_id = env_store_id()
        subdomain_info = check_external_subdomain(store_id)
        
        # Verificar se o processo está rodando
        process_running = bool(tunnel_process and (tunnel_process.poll() is None))
        
        response_data = {
            'tunnel': {
                'connected': tunnel_info.get('has_connections', False),
                'connections': tunnel_info.get('connections_observed', 0),
                'ok': tunnel_info.get('ok', False),
                'raw_info': tunnel_info.get('raw', '')[:500]  # Limitar tamanho
            },
            'subdomain': {
                'host': subdomain_info.get('host'),
                'status_code': subdomain_info.get('status_code'),
                'ok': subdomain_info.get('ok', False),
                'error': subdomain_info.get('error')
            },
            'process': {
                'running': process_running,
                'pid': tunnel_process.pid if tunnel_process else None
            },
            'monitoring': {
                'enabled': tunnel_monitoring,
                'check_interval': tunnel_health_check_interval,
                'last_check': last_tunnel_check,
                'connection_failures': tunnel_connection_failures,
                'max_failures': max_tunnel_failures,
                'max_failures_critical': max_tunnel_failures_critical,
                'failure_threshold': tunnel_failure_threshold(),
                'last_subdomain_status_code': last_subdomain_status_code,
                'status': 'active' if tunnel_monitoring else 'inactive'
            },
            'timestamp': datetime.now().isoformat()
        }
        
        logger.info(f"[{request_id}] Tunnel status: Connected={tunnel_info.get('has_connections')}, Process={process_running}")
        
        return jsonify(response_data), 200
    except Exception as e:
        logger.error(f"[{request_id}] Tunnel status check failed: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/tunnel-test', methods=['GET'])
def tunnel_test():
    """
    Endpoint para teste manual e detalhado do túnel
    """
    request_id = f"tunnel_test_{int(time.time() * 1000)}"
    logger.info(f"[{request_id}] Manual tunnel test requested")
    
    try:
        # Teste completo do túnel
        tunnel_name_env = tunnel_target_name()
        store_id = env_store_id()
        
        # 1. Verificar processo
        process_running = bool(tunnel_process and (tunnel_process.poll() is None))
        
        # 2. Verificar informações do túnel
        tunnel_info = get_tunnel_status(tunnel_name_env)
        
        # 3. Verificar subdomínio
        subdomain_info = check_external_subdomain(store_id)
        
        # 4. Teste de conectividade adicional
        connectivity_test = {
            'ok': False,
            'error': None,
            'response_time': None
        }
        
        try:
            import time as time_module
            start_time = time_module.time()
            test_response = requests.get(f"https://{store_hostname(store_id)}/health", timeout=10)
            response_time = time_module.time() - start_time
            
            connectivity_test = {
                'ok': test_response.status_code == 200,
                'status_code': test_response.status_code,
                'response_time': round(response_time, 3),
                'error': None
            }
        except Exception as e:
            connectivity_test['error'] = str(e)
        
        # Determinar status geral
        overall_status = 'healthy'
        if not process_running:
            overall_status = 'process_down'
        elif not tunnel_info.get('has_connections', False):
            overall_status = 'no_connections'
        elif not subdomain_info.get('ok', False):
            overall_status = 'subdomain_error'
        elif not connectivity_test.get('ok', False):
            overall_status = 'connectivity_error'
        
        response_data = {
            'overall_status': overall_status,
            'timestamp': datetime.now().isoformat(),
            'tests': {
                'process': {
                    'running': process_running,
                    'pid': tunnel_process.pid if tunnel_process else None
                },
                'tunnel_info': {
                    'ok': tunnel_info.get('ok', False),
                    'has_connections': tunnel_info.get('has_connections', False),
                    'connections': tunnel_info.get('connections_observed', 0),
                    'raw_info': tunnel_info.get('raw', '')[:1000]
                },
                'subdomain': {
                    'host': subdomain_info.get('host'),
                    'ok': subdomain_info.get('ok', False),
                    'status_code': subdomain_info.get('status_code'),
                    'error': subdomain_info.get('error')
                },
                'connectivity': connectivity_test
            },
            'recommendations': []
        }
        
        # Adicionar recomendações baseadas no status
        if overall_status == 'process_down':
            response_data['recommendations'].append('Restart the tunnel process')
        elif overall_status == 'no_connections':
            response_data['recommendations'].append('Check tunnel configuration and credentials')
        elif overall_status == 'subdomain_error':
            response_data['recommendations'].append('Check DNS configuration and tunnel routing')
        elif overall_status == 'connectivity_error':
            response_data['recommendations'].append('Check network connectivity and firewall settings')
        
        logger.info(f"[{request_id}] Tunnel test completed: {overall_status}")
        
        return jsonify(response_data), 200
        
    except Exception as e:
        logger.error(f"[{request_id}] Tunnel test error: {str(e)}")
        return jsonify({'error': str(e), 'timestamp': datetime.now().isoformat()}), 500

@app.route('/tunnel-monitoring', methods=['GET', 'POST'])
def tunnel_monitoring_control():
    """
    Endpoint para controlar o monitoramento do túnel
    GET: Retorna status do monitoramento
    POST: Liga/desliga o monitoramento
    """
    global tunnel_monitoring
    request_id = f"monitoring_{int(time.time() * 1000)}"
    
    if request.method == 'GET':
        logger.info(f"[{request_id}] Monitoring status requested")
        
        return jsonify({
            'monitoring': {
                'enabled': tunnel_monitoring,
                'check_interval': tunnel_health_check_interval,
                'last_check': last_tunnel_check,
                'connection_failures': tunnel_connection_failures,
                'max_failures': max_tunnel_failures,
                'max_failures_critical': max_tunnel_failures_critical,
                'failure_threshold': tunnel_failure_threshold(),
                'last_subdomain_status_code': last_subdomain_status_code,
                'status': 'active' if tunnel_monitoring else 'inactive'
            },
            'tunnel_health': 'not_checked',  # Removido para evitar requisições desnecessárias
            'timestamp': datetime.now().isoformat()
        }), 200
    
    elif request.method == 'POST':
        data = request.get_json() or {}
        action = data.get('action', '').lower()
        
        logger.info(f"[{request_id}] Monitoring control: {action}")
        
        if action == 'start':
            tunnel_monitoring = True
            logger.info(f"[{request_id}] ✅ Tunnel monitoring started")
            return jsonify({
                'success': True,
                'message': 'Tunnel monitoring started',
                'monitoring': {
                    'enabled': tunnel_monitoring,
                    'check_interval': tunnel_health_check_interval
                }
            }), 200
            
        elif action == 'stop':
            tunnel_monitoring = False
            logger.info(f"[{request_id}] ⏹️ Tunnel monitoring stopped")
            return jsonify({
                'success': True,
                'message': 'Tunnel monitoring stopped',
                'monitoring': {
                    'enabled': tunnel_monitoring
                }
            }), 200
            
        elif action == 'restart':
            logger.info(f"[{request_id}] 🔄 Manual restart requested")
            restart_application()
            return jsonify({
                'success': True,
                'message': 'Application restart initiated'
            }), 200
            
        else:
            return jsonify({
                'success': False,
                'error': 'Invalid action. Use: start, stop, or restart'
            }), 400

@app.route('/cleanup', methods=['POST'])
def cleanup_processes():
    """
    Endpoint para limpeza manual de processos cloudflared órfãos
    """
    request_id = f"cleanup_{int(time.time() * 1000)}"
    logger.info(f"[{request_id}] Cleanup request received")
    
    try:
        # Limpar processos cloudflared
        cloudflared_killed = kill_cloudflared_processes()
        
        # Verificar se há processos na porta
        port_processes = find_processes_using_port(SERVER_PORT)
        port_killed = 0
        if port_processes:
            port_killed = kill_processes_on_port(SERVER_PORT)
        
        response_data = {
            'message': 'Limpeza concluída',
            'cloudflared_processes_killed': cloudflared_killed,
            'port_processes_killed': port_killed,
            'total_killed': cloudflared_killed + port_killed
        }
        
        logger.info(f"[{request_id}] Cleanup completed:")
        logger.info(f"[{request_id}]   Cloudflared processes killed: {cloudflared_killed}")
        logger.info(f"[{request_id}]   Port processes killed: {port_killed}")
        
        return jsonify(response_data), 200
    except Exception as e:
        logger.error(f"[{request_id}] Cleanup failed: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/provision', methods=['POST'])
def provision_store():
    """
    Provisiona nova loja a partir de store_id (JSON: {"store_id":"PB300"}).
    - Alinha STORE_ID e TUNNEL_NAME
    - Garante/cria túnel e rota DNS
    - Reescreve config.yml deste PC
    """
    request_id = f"provision_{int(time.time() * 1000)}"
    start_time = time.time()
    
    try:
        payload = request.get_json(silent=True) or {}
        logger.info(f"[{request_id}] Provision request received with payload: {payload}")
        
        target = str(payload.get('store_id', '')).strip().upper()
        if not target:
            logger.error(f"[{request_id}] Missing store_id in request payload")
            return jsonify({'error': 'store_id ausente'}), 400

        logger.info(f"[{request_id}] Provisioning store: {target}")

        # Usar variáveis de ambiente APENAS se já estiverem definidas externamente.
        # Aqui não persistimos nada; apenas usamos o target recebido na chamada.

        # Garantir túnel e atualizar config
        config_path = resolve_resource('config.yml')
        logger.info(f"[{request_id}] Using config path: {config_path}")
        
        ensured = ensure_tunnel_and_config(target, config_path)
        processing_time = time.time() - start_time

        response_data = {
            'message': 'Provisionamento concluído',
            'store_id': target,
            'tunnel_name': target,
            'config_path': ensured or config_path,
            'tip': 'Reinicie o processo para que o novo túnel seja usado imediatamente'
        }
        
        logger.info(f"[{request_id}] Provision completed successfully in {processing_time:.3f}s:")
        logger.info(f"[{request_id}]   Store ID: {target}")
        logger.info(f"[{request_id}]   Config path: {ensured or config_path}")
        
        return jsonify(response_data), 200
    except Exception as e:
        processing_time = time.time() - start_time
        logger.error(f"[{request_id}] Provision failed after {processing_time:.3f}s: {str(e)}")
        return jsonify({'error': str(e)}), 500

def stop_cloudflared_only() -> None:
    """Para apenas cloudflared — mantém Flask, heartbeat e monitoramento de rede."""
    global tunnel_process
    try:
        if tunnel_process:
            logger.info("Parando processo cloudflared...")
            tunnel_process.terminate()
            try:
                tunnel_process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    tunnel_process.kill()
                except Exception:
                    pass
            tunnel_process = None
            logger.info("Cloudflare Tunnel parado")
        kill_cloudflared_processes()
    except Exception as e:
        logger.warning(f"Erro ao parar cloudflared: {e}")


def stop_tunnel():
    """
    Para o Cloudflare Tunnel ao encerrar o servidor
    """
    global tunnel_process, tunnel_monitoring, network_monitoring
    tunnel_monitoring = False
    network_monitoring = False

    try:
        stop_cloudflared_only()

        # Parar monitoramento do túnel
        try:
            tunnel_monitoring = False
            logger.info("Tunnel monitoring stopped")
        except Exception as e:
            logger.warning(f"Erro ao parar monitoramento: {e}")
        
        # Parar thread executor
        try:
            logger.info("Parando thread executor...")
            thread_executor.shutdown(wait=False)
            logger.info("Thread executor parado")
        except Exception as e:
            logger.warning(f"Erro ao parar thread executor: {e}")
        
        # Remover arquivo de lock
        try:
            remove_lock_file()
        except Exception as e:
            logger.warning(f"Erro ao remover arquivo de lock: {e}")
            
    except Exception as e:
        logger.warning(f"Erro durante finalização: {e}")

def signal_handler(signum, frame):
    """Handler para sinais de interrupção"""
    logger.info(f"{Fore.YELLOW}🛑 Received signal {signum}, shutting down gracefully...{Style.RESET_ALL}")
    stop_tunnel()
    sys.exit(0)

def run_server() -> None:
    # Registrar função para parar o tunnel ao encerrar
    atexit.register(stop_tunnel)

    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(line_buffering=True)
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(line_buffering=True)
    
    # Registrar handlers para sinais de interrupção
    signal.signal(signal.SIGINT, signal_handler)   # Ctrl+C
    signal.signal(signal.SIGTERM, signal_handler)  # Terminação
    
    # Verificar arquivo de lock primeiro
    if check_lock_file():
        log_section("INSTANCE ALREADY RUNNING", "ERROR")
        logger.error(f"{Fore.RED}❌ Server instance already running (lock file found){Style.RESET_ALL}")
        logger.error(f"{Fore.RED}❌ Please terminate existing instance before starting a new one{Style.RESET_ALL}")
        fatal_exit(1, 'Outra instância do agente já está em execução.')
    
    # Verificar e limpar processos existentes na porta
    if not check_and_cleanup_existing_instances():
        log_section("PORT UNAVAILABLE", "ERROR")
        logger.error(f"{Fore.RED}❌ Could not release port 8080. Check for other processes using the port{Style.RESET_ALL}")
        fatal_exit(1, 'Porta 8080 em uso. Feche o outro programa ou altere SERVER_PORT.')
    
    # Criar arquivo de lock
    if not create_lock_file():
        log_section("LOCK FILE ERROR", "ERROR")
        logger.error(f"{Fore.RED}❌ Could not create lock file. Aborting initialization{Style.RESET_ALL}")
        fatal_exit(1, 'Não foi possível criar o arquivo de lock.')
    
    log_section("INSTANCE CONFIRMED", "INFO")
    
    # Validar STORE_ID (obrigatório)
    try:
        store_id = require_store_id()
        env_sync = ensure_env_alignment()
        logger.info(f"{Fore.CYAN}📋 Environment: {Fore.WHITE}{env_sync.get('target')}{Style.RESET_ALL} (source: {env_sync.get('source')})")
        logger.info(f"{Fore.CYAN}🏪 STORE_ID (Windows): {Fore.WHITE}{store_id}{Style.RESET_ALL}")
        if os.name == 'nt':
            reg_store = _read_windows_registry_env('STORE_ID')
            if reg_store:
                logger.info(f"{Fore.CYAN}📌 STORE_ID no registro Windows: {Fore.WHITE}{reg_store.upper()}{Style.RESET_ALL}")
        env_file = load_local_env()
        if env_file:
            logger.info(f"{Fore.CYAN}📄 .env carregado: {Fore.WHITE}{env_file}{Style.RESET_ALL}")
        lav60_tok = _resolve_machines_api_token()
        if lav60_tok:
            src = 'registro Windows' if _read_windows_registry_env('LAV60_API_TOKEN') else '.env'
            logger.info(f"{Fore.CYAN}🔑 LAV60_API_TOKEN: {Fore.GREEN}ok{Style.RESET_ALL} ({src})")
        else:
            logger.warning(
                f"{Fore.YELLOW}⚠️ LAV60_API_TOKEN ausente — dados das máquinas (API) não serão carregados{Style.RESET_ALL}"
            )
    except RuntimeError as e:
        log_section("STORE_ID REQUIRED", "ERROR")
        logger.error(f"{Fore.RED}❌ {e}{Style.RESET_ALL}")
        remove_lock_file()
        fatal_exit(1, str(e))
    except Exception as e:
        log_section("ENVIRONMENT ERROR", "ERROR")
        logger.error(f"{Fore.RED}❌ Failed to read environment: {e}{Style.RESET_ALL}")
        remove_lock_file()
        fatal_exit(1, f'Erro ao ler variáveis de ambiente: {e}')

    load_store_machines_catalog(store_id)

    log_section("STARTING PROXY SERVER", "INFO")
    logger.info(f"{Fore.CYAN}🌐 Server: {Fore.WHITE}http://0.0.0.0:8080{Style.RESET_ALL}")
    logger.info(f"{Fore.CYAN}🎯 Target: {Fore.WHITE}{TARGET_SERVER}{Style.RESET_ALL}")
    logger.info(f"{Fore.CYAN}🆔 Process ID: {Fore.WHITE}{os.getpid()}{Style.RESET_ALL}")
    logger.info(f"{Fore.CYAN}📄 Log file: {Fore.WHITE}{log_file_path()}{Style.RESET_ALL}")
    logger.info(f"{Fore.CYAN}📁 Config: {Fore.WHITE}{resolve_config_path()}{Style.RESET_ALL}")
    
    # Iniciar o Cloudflare Tunnel
    start_tunnel()
    
    # Aguarda mais tempo para o tunnel conectar e imprime diagnóstico inicial no console
    try:
        logger.info(f"{Fore.YELLOW}⏳ Waiting for tunnel to establish connection...{Style.RESET_ALL}")
        time.sleep(10)  # Aguardar mais tempo para o tunnel conectar
        snapshot = build_debug_snapshot()
        
        log_section("SYSTEM DIAGNOSTICS", "INFO")
        logger.info(f"{Fore.CYAN}🏪 Store ID: {Fore.WHITE}{snapshot.get('store_id')}{Style.RESET_ALL}")
        logger.info(f"{Fore.CYAN}🎯 Target Server: {Fore.WHITE}{snapshot.get('target_server')}{Style.RESET_ALL}")
        logger.info(f"{Fore.CYAN}📁 Config Path: {Fore.WHITE}{snapshot.get('config_path')}{Style.RESET_ALL}")
        logger.info(f"{Fore.CYAN}🔧 Cloudflared: {Fore.WHITE}{snapshot.get('cloudflared_version')}{Style.RESET_ALL}")
        
        t = snapshot.get('tunnel', {})
        tunnel_status = "Connected" if t.get('has_connections') else "Connecting"
        tunnel_color = Fore.GREEN if t.get('has_connections') else Fore.YELLOW
        logger.info(f"{Fore.CYAN}🚇 Tunnel Status: {tunnel_color}{tunnel_status}{Style.RESET_ALL}")
        logger.info(f"{Fore.CYAN}🔗 Active Connections: {Fore.WHITE}{t.get('connections_observed', 0)}{Style.RESET_ALL}")
        
        # Adicionar informação sobre o tempo de inicialização
        if not t.get('has_connections'):
            logger.info(f"{Fore.YELLOW}💡 Note: Tunnel may take 10-30 seconds to fully connect{Style.RESET_ALL}")
        
        s = snapshot.get('subdomain_check', {})
        subdomain_status = "OK" if s.get('ok') else "Connecting"
        subdomain_color = Fore.GREEN if s.get('ok') else Fore.YELLOW
        logger.info(f"{Fore.CYAN}🌐 Subdomain: {Fore.WHITE}{s.get('host')}{Style.RESET_ALL}")
        logger.info(f"{Fore.CYAN}📊 Subdomain Status: {subdomain_color}{subdomain_status} ({s.get('status_code')}){Style.RESET_ALL}")
        
        # Adicionar informação sobre o status do subdomínio
        if not s.get('ok'):
            if s.get('status_code') == 502:
                logger.info(f"{Fore.YELLOW}💡 Note: 502 error is normal while tunnel is connecting{Style.RESET_ALL}")
            elif s.get('status_code') is None:
                logger.info(f"{Fore.YELLOW}💡 Note: Connection timeout - tunnel may still be connecting{Style.RESET_ALL}")
        
        process_status = "Running" if snapshot.get('tunnel_process_running') else "Stopped"
        process_color = Fore.GREEN if snapshot.get('tunnel_process_running') else Fore.RED
        logger.info(f"{Fore.CYAN}⚙️ Tunnel Process: {process_color}{process_status}{Style.RESET_ALL}")
        
    except Exception as e:
        logger.warning(f"{Fore.YELLOW}⚠️ Failed to print initial diagnostics: {str(e)}{Style.RESET_ALL}")

    # Iniciar monitoramento do túnel em background
    logger.info(f"{Fore.CYAN}🔍 Starting tunnel monitoring...{Style.RESET_ALL}")
    monitoring_thread = threading.Thread(target=monitor_tunnel_connection, daemon=True)
    monitoring_thread.start()
    logger.info(f"{Fore.GREEN}✅ Tunnel monitoring started (interval: {tunnel_health_check_interval}s){Style.RESET_ALL}")

    network_thread = threading.Thread(target=monitor_network_devices, daemon=True, name='network_monitor')
    network_thread.start()
    logger.info(
        f"{Fore.GREEN}✅ Network monitoring started (interval: {NETWORK_CHECK_INTERVAL}s){Style.RESET_ALL}"
    )

    heartbeat_thread = threading.Thread(target=monitor_panel_heartbeat, daemon=True, name='panel_heartbeat')
    heartbeat_thread.start()

    # Iniciar o servidor Flask
    try:
        app.run(host='0.0.0.0', port=8080, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        logger.info("Servidor interrompido pelo usuário")
        stop_tunnel()


if __name__ == '__main__':
    try:
        run_server()
    except SystemExit:
        raise
    except Exception as e:
        logger.exception('Falha fatal ao iniciar o agente')
        fatal_exit(1, f'Falha fatal: {e}')
