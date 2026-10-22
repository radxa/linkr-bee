//! Token accounting (`web/agent_usage.js`).
//!
//! Every assistant message carries a Usage record; the panel sums them per
//! conversation and can estimate a cost when the user enters the endpoint's
//! per-million-token prices. Prices are display-only and never touch a request.

pub const PRICING_KEY: &str = "linkr-agent-pricing-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total_tokens: u64,
    pub messages: u64,
}

pub fn empty_usage() -> Usage {
    Usage::default()
}

/// Add one message's usage to a running total.
pub fn add_usage(total: &Usage, usage: &Usage) -> Usage {
    let mut next = *total;
    next.input += usage.input;
    next.output += usage.output;
    next.cache_read += usage.cache_read;
    next.cache_write += usage.cache_write;
    let component_sum = usage.input + usage.output + usage.cache_read + usage.cache_write;
    next.total_tokens += if usage.total_tokens > 0 {
        usage.total_tokens
    } else {
        component_sum
    };
    next.messages += 1;
    next
}

/// Per-million-token prices, the way providers list them.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Pricing {
    pub input: f64,
    pub output: f64,
}

/// Parse `{ input, output }` prices, each per million tokens, 0..=100000.
pub fn parse_pricing(input: f64, output: f64) -> Result<Pricing, &'static str> {
    let rate = |v: f64| {
        if v == 0.0 {
            return Ok(0.0);
        }
        if !v.is_finite() || v < 0.0 || v > 100_000.0 {
            return Err("bad price");
        }
        Ok(v)
    };
    Ok(Pricing {
        input: rate(input)?,
        output: rate(output)?,
    })
}

/// Estimate the cost of a usage total against prices. Returns `None` when both
/// prices are zero (costs are not configured).
pub fn estimate_cost(usage: &Usage, pricing: &Pricing) -> Option<Pricing> {
    if pricing.input == 0.0 && pricing.output == 0.0 {
        return None;
    }
    let input = usage.input as f64 / 1e6 * pricing.input;
    let output = usage.output as f64 / 1e6 * pricing.output;
    Some(Pricing { input, output })
}

/// Format a token count with thousands separators (`en-US` grouping).
pub fn format_tokens(value: u64) -> String {
    let s = value.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

/// Format a small dollar amount with enough digits to be useful without
/// pretending to more precision than the price has.
pub fn format_cost(amount: f64) -> String {
    if amount == 0.0 {
        return "0".to_string();
    }
    if amount < 0.01 {
        format!("{amount:.4}")
    } else if amount < 1.0 {
        format!("{amount:.3}")
    } else {
        format!("{amount:.2}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_accumulates_and_counts_messages() {
        let mut total = empty_usage();
        total = add_usage(
            &total,
            &Usage {
                input: 100,
                output: 50,
                total_tokens: 160,
                ..Default::default()
            },
        );
        total = add_usage(
            &total,
            &Usage {
                input: 20,
                output: 30,
                total_tokens: 0,
                ..Default::default()
            },
        );
        assert_eq!(total.input, 120);
        assert_eq!(total.output, 80);
        // Second message has no total_tokens, so it falls back to components.
        assert_eq!(total.total_tokens, 160 + 50);
        assert_eq!(total.messages, 2);
    }

    #[test]
    fn prices_out_of_range_are_rejected() {
        assert!(parse_pricing(-1.0, 0.0).is_err());
        assert!(parse_pricing(0.0, 100_001.0).is_err());
        assert!(parse_pricing(0.0, f64::NAN).is_err());
        assert!(parse_pricing(1.0, 2.0).is_ok());
    }

    #[test]
    fn zero_prices_mean_no_cost_estimate() {
        assert_eq!(
            estimate_cost(
                &Usage {
                    input: 1000,
                    output: 1000,
                    ..Default::default()
                },
                &Pricing::default()
            ),
            None
        );
    }

    #[test]
    fn cost_is_per_million_tokens() {
        let c = estimate_cost(
            &Usage {
                input: 1_000_000,
                output: 500_000,
                ..Default::default()
            },
            &Pricing {
                input: 2.0,
                output: 4.0,
            },
        )
        .unwrap();
        assert_eq!(c.input, 2.0);
        assert_eq!(c.output, 2.0);
    }

    #[test]
    fn token_formatting_groups_thousands() {
        assert_eq!(format_tokens(0), "0");
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(1000), "1,000");
        assert_eq!(format_tokens(1234567), "1,234,567");
    }
}
