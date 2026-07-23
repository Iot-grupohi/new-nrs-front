"""Base de conhecimento / suporte customizável."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/support", tags=["panel-support"])

_custom_store: dict[str, Any] = {"categories": [], "procedures": []}


@router.get("/custom")
async def support_custom() -> dict[str, Any]:
    return {
        "store": _custom_store,
        "meta": {"category_ids": [], "procedure_keys": []},
        "can_edit": False,
        "persistence": {"firestore": False},
    }


@router.post("/categories")
async def create_category(body: dict[str, Any]) -> dict[str, Any]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")


@router.put("/categories/{category_id}")
async def update_category(category_id: str, body: dict[str, Any]) -> dict[str, Any]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")


@router.delete("/categories/{category_id}")
async def delete_category(category_id: str) -> dict[str, str]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")


@router.post("/procedures")
async def create_procedure(body: dict[str, Any]) -> dict[str, Any]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")


@router.put("/procedures/{category_id}/{procedure_id}")
async def update_procedure(category_id: str, procedure_id: str, body: dict[str, Any]) -> dict[str, Any]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")


@router.delete("/procedures/{category_id}/{procedure_id}")
async def delete_procedure(category_id: str, procedure_id: str) -> dict[str, str]:
    raise HTTPException(403, "Edição desabilitada neste ambiente")
