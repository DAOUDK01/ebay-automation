"""eBay OAuth: user token (from refresh token) for your seller account,
application token for public Browse/Taxonomy calls."""
from __future__ import annotations

import base64
import time
from urllib.parse import quote

import requests

TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
AUTHORIZE_URL = "https://auth.ebay.com/oauth2/authorize"

USER_SCOPES = [
    "https://api.ebay.com/oauth/api_scope",
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
    "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
]
APP_SCOPES = ["https://api.ebay.com/oauth/api_scope"]


class EbayAuth:
    def __init__(self, client_id: str, client_secret: str, refresh_token: str = ""):
        if not client_id or not client_secret:
            raise RuntimeError("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET missing in .env")
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_token = refresh_token
        self._user = (None, 0.0)
        self._app = (None, 0.0)

    def _basic(self) -> str:
        raw = f"{self.client_id}:{self.client_secret}".encode()
        return "Basic " + base64.b64encode(raw).decode()

    def _post(self, data: dict) -> dict:
        r = requests.post(
            TOKEN_URL,
            headers={"Authorization": self._basic(),
                     "Content-Type": "application/x-www-form-urlencoded"},
            data=data, timeout=30,
        )
        if r.status_code != 200:
            raise RuntimeError(f"eBay OAuth error {r.status_code}: {r.text}")
        return r.json()

    def user_token(self) -> str:
        tok, exp = self._user
        if tok and time.time() < exp - 120:
            return tok
        if not self.refresh_token:
            raise RuntimeError("EBAY_REFRESH_TOKEN missing - run: python get_token.py")
        j = self._post({"grant_type": "refresh_token",
                        "refresh_token": self.refresh_token,
                        "scope": " ".join(USER_SCOPES)})
        self._user = (j["access_token"], time.time() + int(j["expires_in"]))
        return j["access_token"]

    def app_token(self) -> str:
        tok, exp = self._app
        if tok and time.time() < exp - 120:
            return tok
        j = self._post({"grant_type": "client_credentials", "scope": " ".join(APP_SCOPES)})
        self._app = (j["access_token"], time.time() + int(j["expires_in"]))
        return j["access_token"]

    # --- one-time consent flow helpers (used by get_token.py) ---
    def consent_url(self, runame: str) -> str:
        return (f"{AUTHORIZE_URL}?client_id={quote(self.client_id)}"
                f"&redirect_uri={quote(runame)}&response_type=code"
                f"&scope={quote(' '.join(USER_SCOPES))}")

    def exchange_code(self, code: str, runame: str) -> dict:
        return self._post({"grant_type": "authorization_code", "code": code,
                           "redirect_uri": runame})
