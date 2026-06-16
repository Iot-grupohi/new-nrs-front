# -*- mode: python ; coding: utf-8 -*-
# Build one-file: pyinstaller lav60_gateway.spec --noconfirm --clean
# O .env da raiz do projeto e embutido no executavel no momento do build.

import os

from PyInstaller.utils.hooks import collect_all

block_cipher = None
_project_root = os.path.abspath(os.path.dirname(SPEC))

datas = [
    ('config/config.template.yml', '.'),
]

_env_path = os.path.join(_project_root, '.env')
if os.path.isfile(_env_path):
    datas.append((_env_path, '.'))
else:
    print('AVISO: .env nao encontrado na raiz — executavel sem configuracao embutida.')

hiddenimports = [
    'proxy_server',
    'flask',
    'werkzeug',
    'werkzeug.routing',
    'werkzeug.serving',
    'jinja2',
    'colorama',
    'psutil',
    'requests',
    'urllib3',
    'certifi',
    'charset_normalizer',
    'idna',
    'winreg',
    'dotenv',
    'lav60_env',
]

for pkg in ('flask', 'werkzeug', 'jinja2'):
    try:
        tmp_ret = collect_all(pkg)
        datas += tmp_ret[0]
        hiddenimports += tmp_ret[1]
    except Exception:
        pass

a = Analysis(
    ['backend/launcher.py'],
    pathex=['.', 'backend'],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
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
    name='LAV60_Gateway',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
