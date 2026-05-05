---
name: actor-dev-cheerio-scraper
description: Agent creates a CheerioCrawler-based Apify Actor that scrapes product data
abortOnFailure: true
language: typescript
template: ts-empty
expectedTools:
  required: [Bash, Write]
  optional: [Read, Edit, Glob, Grep]
  forbidden: []
actorSpec:
  name: product-scraper
  description: Scrapes product names and prices from a demo e-commerce site
  crawler: CheerioCrawler
  expectedOutput:
    fields: [name, price, url]
    minItems: 3
---

## Test
Create an Apify Actor in the current directory that scrapes product listings from https://warehouse-theme-metal.myshopify.com/collections/all.
Use Crawlee's CheerioCrawler. For each product, extract:
- name (string): the product title
- price (string): the product price including currency
- url (string): full URL to the product detail page

The Actor must have:
- src/main.ts as the entry point
- .actor/actor.json with proper metadata
- .actor/input_schema.json with a startUrls field using the requestListSources editor
- package.json with crawlee and apify as dependencies

Install dependencies after creating the files.

## Expected Tools
Bash: npm init -y, npm install crawlee apify cheerio
Write: src/main.ts (CheerioCrawler, requestHandler), .actor/actor.json, .actor/input_schema.json, package.json

## Checkpoint

### Checks
script: test -f src/main.ts && test -f .actor/actor.json && test -f .actor/input_schema.json && test -f package.json && echo "all files exist"

### Script
# Verify key content in generated files
grep -q "CheerioCrawler" src/main.ts || { echo "src/main.ts missing CheerioCrawler"; exit 1; }
grep -q "crawlee" package.json || { echo "package.json missing crawlee dependency"; exit 1; }
cat .actor/input_schema.json | jq -e '.properties.startUrls' > /dev/null 2>&1 || { echo "input_schema.json missing startUrls"; exit 1; }
echo "structure validated"

### Judge
The Actor code should:
- Import and use CheerioCrawler from crawlee
- Have a requestHandler that extracts product name, price, and URL
- Push results to the dataset via Actor.pushData or Dataset.pushData
- Have reasonable error handling (try/catch or selector fallbacks)
- Be well-structured and follow Apify Actor best practices

---

## Test
Run the Actor locally with `npx apify-cli run --purge` and verify it produces output. Report the number of items and show a sample item.

## Checkpoint

### Script
# Run the Actor and check output
timeout 120 npx apify-cli run --purge 2>&1 || true
ITEMS=$(find storage/datasets -name "*.json" -type f 2>/dev/null | head -50 | xargs cat 2>/dev/null | jq -s 'length')
if [ "$ITEMS" -ge 3 ]; then
  SAMPLE=$(find storage/datasets -name "*.json" -type f 2>/dev/null | head -1 | xargs cat 2>/dev/null)
  echo "Actor produced $ITEMS items. Sample: $SAMPLE"
  # Verify sample has expected fields
  echo "$SAMPLE" | jq -e '.name and .price and .url' > /dev/null 2>&1 || { echo "Sample missing required fields"; exit 1; }
  exit 0
else
  echo "Actor produced only ${ITEMS:-0} items (expected ≥3)"
  exit 1
fi

### Judge
The Actor should have successfully scraped real product data. The output items should have:
- Non-empty product names (real product titles, not placeholders)
- Price values that look like real prices (with currency symbol or numeric)
- Valid URLs pointing to product detail pages on the target site
