# Daemon #2 — once an hour, buys daemon #1's skill over x402, keeps the answer, and tells #1 what it got. (testnet)
strategy "watch_movers" {
  description = "Hourly: pay daemon #1 for the top movers, log them, and send #1 a signed receipt note."
  every = "1h"
  input { }
  step "buy" {
    x402 = "https://obol.sh/d/1/top_movers"
    max  = "0.02"
  }
  step "tell" {
    message = 1
    body    = "Receipt (suggested by daemon #1): paid 0.02 tUSDG for top_movers. Got: ${steps.buy.body}"
  }
  output = "${steps.buy.body}"
}

# OTC (milestone 09): what it may trade with siblings — the holder's limits.
otc {
  instruments = ["tUSDG", "tNVDA", "tNVX"]
  max_open    = 3
  max_usd     = "5"
}

# Once a day: offer 3 tNVDA for 1.80 tUSDG to any sibling, open for 24 hours.
strategy "sell_nvda" {
  description = "Daily: offer 3 tNVDA for 1.80 tUSDG to siblings through DaemonOTC."
  every = "24h"
  input { }
  step "post" {
    offer {
      give    = ["3 tNVDA"]
      want    = ["1.80 tUSDG"]
      expires = "24h"
    }
  }
}

# Options (milestone 10, testnet only): what it may do with covered calls and cash-secured puts — the holder's limits.
options {
  underlyings = ["tNVDA"]
  max_open    = 3
  max_usd     = "5"
}

# Once a day: write a covered call — 3 tNVDA locked, sold to a sibling at 1.50 tUSDG for the lot if exercised.
strategy "write_calls" {
  description = "Daily: write a covered call on 3 tNVDA struck at 1.50 tUSDG, premium 0.10, for 72 hours."
  every = "24h"
  input { }
  step "write" {
    write_option {
      kind    = "call"
      stock   = "3 tNVDA"
      strike  = "1.50 tUSDG"
      premium = "0.10 tUSDG"
      expires = "72h"
    }
  }
}

# Once a day: exercise any put it holds that beats the OTC book's best bid, then buy a put on 3 tNVDA struck at least 1.00.
strategy "puts" {
  description = "Daily: exercise held puts that are in the money against the OTC book, then buy a put on 3 tNVDA."
  every = "24h"
  input { }
  step "exercise" {
    exercise {
      reference = "otc"
    }
  }
  step "buy" {
    buy_option {
      kind            = "put"
      stock_at_least  = "3 tNVDA"
      strike_at_least = "1.00 tUSDG"
      premium_at_most = "0.10 tUSDG"
    }
    skip_if_none = true
  }
}

# Index (milestone 11): what it publishes — one share holds exactly 1 tNVDA and 0.40 tUSDG, fixed forever on chain.
index "tNVX" {
  name   = "NVDA + cash (testnet)"
  basket = ["1 tNVDA", "0.40 tUSDG"]
}

# Daily: mint one share of its index (deposits 1 tNVDA + 0.40 tUSDG) and offer it to siblings for 1.00 tUSDG.
strategy "make_tnvx" {
  description = "Daily: mint one tNVX share from its basket and offer it to siblings for 1.00 tUSDG for 24 hours."
  every = "24h"
  input { }
  step "mint" {
    mint_index {
      index  = "tNVX"
      shares = 1
    }
  }
  step "sell" {
    offer {
      give    = ["1 tNVX"]
      want    = ["1.00 tUSDG"]
      expires = "24h"
    }
  }
}

# Bounded swaps (milestone 12, testnet only): what it may do — the holder's limits; max_usd = the most one swap may lose.
swaps {
  underlyings = ["NVDA"]
  max_open    = 2
  max_usd     = "3"
}

# Daily: offer to be LONG NVDA against a sibling — 10 tUSDG notional, the move capped at ±20%, for 6 hours. Each side
# escrows 2.00; settled on Chainlink's NVDA/USD (mirrored to testnet) at the first price round after expiry.
strategy "nvda_long" {
  description = "Daily: offer a 6-hour long NVDA swap, 10 tUSDG notional, capped at ±20% (2.00 escrowed a side)."
  every = "24h"
  input { }
  step "offer" {
    swap_offer {
      underlying = "NVDA"
      side       = "long"
      notional   = "10 tUSDG"
      cap        = "20%"
      term       = "6h"
      max_stale  = "6h"
      expires    = "24h"
    }
  }
}
