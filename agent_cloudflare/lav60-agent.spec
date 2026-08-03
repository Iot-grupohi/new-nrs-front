# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — Lav60Agent.exe único (onefile, .env embarcado)."""

from pathlib import Path

import certifi

agent_dir = Path(SPECPATH)

block_cipher = None

hiddenimports = [
    'lav60_env',
    'lav60_firebase_rtdb',
    'colorama',
    'psutil',
    'psutil._psutil_windows',
    'flask',
    'werkzeug',
    'werkzeug.routing',
    'jinja2',
    'click',
    'itsdangerous',
    'markupsafe',
    'requests',
    'urllib3',
    'certifi',
    'charset_normalizer',
    'idna',
    'firebase_admin',
    'firebase_admin.credentials',
    'firebase_admin.db',
    'firebase_admin._auth_utils',
    'google.auth',
    'google.auth.transport',
    'google.auth.transport.requests',
    'google.oauth2',
    'google.oauth2.service_account',
    'google.cloud',
    'google.api_core',
    'grpc',
    'cachecontrol',
    'cachecontrol.caches',
    'cachecontrol.caches.file_cache',
]

datas = [(certifi.where(), 'certifi')]
template = agent_dir / 'config.template.yml'
if template.is_file():
    datas.append((str(template), '.'))

embedded_env = agent_dir / 'build' / '.env'
if embedded_env.is_file():
    datas.append((str(embedded_env), '.'))
else:
    fallback_env = agent_dir / '.env'
    if fallback_env.is_file():
        datas.append((str(fallback_env), '.'))

runtime_hooks = [str(agent_dir / 'pyi_rth_certifi.py')]

a = Analysis(
    [str(agent_dir / 'proxy_server.py')],
    pathex=[str(agent_dir)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=runtime_hooks,
    excludes=['matplotlib', 'numpy', 'pandas', 'tkinter', 'pytest'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='Lav60Agent',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    version=str(agent_dir / 'version_info.txt'),
)
