"""Loads secrets from .env and tunable settings from settings.toml."""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Config:
    settings: dict
    ebay_client_id: str
    ebay_client_secret: str
    ebay_runame: str
    ebay_refresh_token: str
    root: Path = ROOT

    def get(self, section: str, key: str, default=None):
        return self.settings.get(section, {}).get(key, default)

    @property
    def db_path(self) -> Path:
        return self.root / "data" / "optimizer.db"

    @property
    def reports_dir(self) -> Path:
        return self.root / "reports"

    @property
    def logs_dir(self) -> Path:
        return self.root / "logs"


def load_config(root: Path = ROOT) -> Config:
    load_dotenv(root / ".env")
    with open(root / "settings.toml", "rb") as f:
        settings = tomllib.load(f)
    cfg = Config(
        settings=settings,
        ebay_client_id=os.getenv("EBAY_CLIENT_ID", ""),
        ebay_client_secret=os.getenv("EBAY_CLIENT_SECRET", ""),
        ebay_runame=os.getenv("EBAY_RUNAME", ""),
        ebay_refresh_token=os.getenv("EBAY_REFRESH_TOKEN", ""),
        root=root,
    )
    for d in (cfg.db_path.parent, cfg.reports_dir, cfg.logs_dir):
        d.mkdir(parents=True, exist_ok=True)
    return cfg
