"""Gera ícones SVG locais para a página de suporte."""

from __future__ import annotations

from pathlib import Path

ICONS = {
    "Helpdesk": ("#2563eb", "HD"),
    "location": ("#f97316", "MAP"),
    "Maquineta": ("#8b5cf6", "CC"),
    "Lavadora": ("#06b6d4", "LAV"),
    "Noteiro": ("#22c55e", "NT"),
    "Modem": ("#64748b", "NET"),
    "Computador": ("#0ea5e9", "PC"),
    "roupa-suja": ("#eab308", "RP"),
    "Ar-condicionado": ("#38bdf8", "AC"),
    "Erro-no-pagamento": ("#ef4444", "ERR"),
    "pagamento-cartao": ("#ec4899", "NF"),
    "suporte-ao-cliente": ("#14b8a6", "SAC"),
    "sugestao": ("#a855f7", "IDEA"),
}

ROOT = Path(__file__).resolve().parent.parent / "fac" / "img" / "Icons"


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for name, (color, label) in ICONS.items():
        size = "16" if len(label) > 3 else "20"
        svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-hidden="true">
  <rect width="64" height="64" rx="14" fill="#0f172a"/>
  <rect x="6" y="6" width="52" height="52" rx="12" fill="{color}" opacity="0.18"/>
  <text x="32" y="38" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="{size}" font-weight="700" fill="{color}">{label}</text>
</svg>
"""
        (ROOT / f"{name}.svg").write_text(svg, encoding="utf-8")
    print(f"created {len(ICONS)} icons in {ROOT}")


if __name__ == "__main__":
    main()
