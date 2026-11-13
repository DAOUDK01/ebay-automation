"""One-time setup: get an eBay refresh token for your seller account (valid ~18 months).

1. In developer.ebay.com > User Tokens > "Get a Token from eBay via Your Application",
   set up your RuName (redirect URL name). Put it in .env as EBAY_RUNAME.
2. Run: python get_token.py
3. Open the printed link, sign in to eBay YOURSELF and click Agree.
4. You land on a page whose URL contains ?code=... - copy that WHOLE URL and paste it here.
The refresh token is written into .env automatically.
"""
from urllib.parse import parse_qs, unquote, urlparse

from dotenv import set_key

from optimizer.config import ROOT, load_config
from optimizer.ebay_auth import EbayAuth

cfg = load_config()
if not cfg.ebay_runame:
    raise SystemExit("Set EBAY_RUNAME in .env first.")
auth = EbayAuth(cfg.ebay_client_id, cfg.ebay_client_secret)
print("\nOpen this link in your browser and sign in / agree:\n")
print(auth.consent_url(cfg.ebay_runame))
pasted = input("\nPaste the full URL you were redirected to (or just the code): ").strip()
code = parse_qs(urlparse(pasted).query).get("code", [pasted])[0]
tokens = auth.exchange_code(unquote(code), cfg.ebay_runame)
set_key(str(ROOT / ".env"), "EBAY_REFRESH_TOKEN", tokens["refresh_token"])
print(f"\nSaved EBAY_REFRESH_TOKEN to .env (expires in ~{int(tokens.get('refresh_token_expires_in', 0)) // 86400} days).")
