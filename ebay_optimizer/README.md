# eBay Listing Optimizer (eBay API + Claude)

Works through your store in batches. For each batch it:

1. **Pulls** the next N active listings. It picks never-touched listings first, then the weakest (fewest sales or watchers), and skips anything edited in the last `cooldown_days`.
2. **Improves each listing:**
   - reads the full listing
   - looks up the category's required and recommended item specifics
   - searches eBay for competing listings, using the part number first and then the title
   - asks Claude for a better title, missing specifics, a price and fitment suggestions
3. **Checks every suggestion against hard rules:**
   - title must be 80 characters or less, with no spammy words
   - price moves at most ±5% and never goes below cost + margin
   - only valid category specifics, using eBay's allowed values
   - fitment is report-only by default
4. **Pushes** the batch to eBay (`ReviseFixedPriceItem`), writes a CSV report, waits, then pulls the next batch.

## Setup (once)

```bash
cd ebay_optimizer
pip install -r requirements.txt
copy .env.example .env        # then fill in EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME, ANTHROPIC_API_KEY
python get_token.py           # sign in to eBay in your browser, paste back the redirect URL
python run.py check           # verifies eBay + Claude credentials
```

Optional: create a `costs.csv` file (see `costs.csv.example`). Without it, prices are only ever **raised**, never lowered.

Set `exclude_seller` in `settings.toml` to your eBay username.

## Use

```bash
python run.py once --limit 5      # test batch -> reports/batch_0001.csv
python run.py push --batch 1      # push rows with approve=yes (you can edit new_title/new_price first)
python run.py loop                # keep going: batch, gap, next batch (within active_hours)
python run.py status
```

Start in `mode = "review"`. Once the reports look good for a few batches, switch to `mode = "auto"` in `settings.toml`. In auto mode each batch is pushed automatically as soon as it's done.

To keep it running, leave `python run.py loop` open in a terminal, or add it to Windows Task Scheduler ("At log on", restart on failure).

## Cost

With Claude Opus 5.5 at medium effort, expect roughly $0.04–0.08 per listing, so about 1,200–2,000 listings a month on $90. Set `model = "claude-sonnet-5-5"` (with prices 2/10) to roughly halve that. The loop pauses itself when `monthly_budget_usd` is reached.

## What it does not change

- **Shipping policies:** it gives advice only, in the `shipping_notes` column.
- **Descriptions and photos**
- **Variation prices**
- **Auctions**
- **Compatibility:** stays report-only until you set `compatibility.apply = true`. Wrong fitment means returns and defects, so verify first.

Files: `data/optimizer.db` (state), `reports/` (one CSV per batch), `logs/optimizer.log`.
