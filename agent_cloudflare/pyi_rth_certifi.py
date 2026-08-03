"""Runtime hook PyInstaller — certificados TLS (certifi) no executável."""
import os
import sys
from pathlib import Path


def _configure() -> None:
    if not getattr(sys, 'frozen', False):
        return
    meipass = getattr(sys, '_MEIPASS', None)
    candidates: list[Path] = []
    if meipass:
        base = Path(meipass)
        candidates.extend([base / 'certifi' / 'cacert.pem', base / 'cacert.pem'])
    try:
        import certifi

        candidates.append(Path(certifi.where()))
    except ImportError:
        pass
    for path in candidates:
        if path.is_file():
            ca = str(path)
            os.environ['SSL_CERT_FILE'] = ca
            os.environ['REQUESTS_CA_BUNDLE'] = ca
            os.environ['CURL_CA_BUNDLE'] = ca
            return


_configure()
