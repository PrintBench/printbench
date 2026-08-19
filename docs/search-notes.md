# Search behaviour — verified findings

Validated against Postgres 18.4 with real fixture data before any UI was built.
Re-run these checks if the text search configuration changes.

## Configuration

`pm_search` = `english` + `unaccent`, so "pokemon" matches "Pokémon" and stemming
works ("game" matches "games").

## Two non-obvious traps, both hit and fixed

### 1. Filenames tokenise as a single token

Postgres's default parser classifies `presupported/dragon_body.stl` as one `file`
token. Searching "presupported" therefore returns nothing.

**Fix:** `regexp_replace(filename, '[^[:alnum:]]+', ' ', 'g')` before
`to_tsvector`. Verified with `ts_debug`, which then yields
`presupported | dragon | body | stl`.

Note `translate(x, '/_-.', ' ')` does NOT work — when the target string is
shorter than the source set, `translate` *deletes* the unmatched characters,
collapsing `dragon_body.stl` to `dragonbodystl`.

### 2. Trigram operator direction

For typo tolerance use **`query <% target`**, not `%>`.

Postgres defines `a <% b` as `word_similarity(a, b) > threshold`, and `%>` is its
commutator — the arguments are the other way round. Using `%>` silently matches
almost nothing.

Use `word_similarity`, not `similarity`: `similarity()` compares whole strings,
so a short query against a long model name scores far too low
(`similarity('Red Dragon Miniature','dragon')` = 0.12).

## Threshold

`SET pg_trgm.word_similarity_threshold = 0.5` per session. Measured against
"Red Dragon Miniature":

| query      | typo kind      | word_similarity | matches at 0.5 |
|------------|----------------|-----------------|----------------|
| `dragon`   | exact          | 1.000           | yes            |
| `draggon`  | doubled letter | 0.667           | yes            |
| `dragn`    | dropped letter | 0.667           | yes            |
| `minature` | dropped letter | 0.583           | yes            |
| `dargon`   | transposition  | 0.286           | **no**         |
| `banana`   | unrelated      | 0.000           | no             |

**Known limit:** transpositions defeat trigrams — `dargon` shares only 3 trigrams
with `dragon`. Lowering the threshold to 0.25 would catch it but admits noise.

If transposition tolerance is wanted in Phase 5, add the `fuzzystrmatch`
extension and apply `levenshtein(query, name) <= 2` as a rescue pass over a
bounded candidate set for short queries — do not lower the global threshold.
