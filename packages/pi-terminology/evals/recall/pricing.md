# Pricing and model pin

Rechecked the [official model documentation](https://docs.typesafe.ai/models) on
22 October 2026, before inference:

- `jev-1.13.0`: **$0.042 per million input tokens**; output tokens are free.
- Default limits: **64k total request input**, **32k state plus any one question**.
- Long-context mode requires an explicit danger-zone header; this experiment does
  not enable it.
- The documentation also lists `jev-1.14.0`, but this experiment retains the
  authorized **`jev-1.13.0`** pin. No model substitution is authorized or performed.
- Provider SDKs ordinarily retry rate limits; the pinned native path explicitly
  requests **zero retries**, as tested and required by this protocol.

Reservations use 65,536 input tokens per attempt at 42 nanos per token:
**$0.002752512 per attempt**. Thus the planned 1,786 calls reserve
**$4.915986432** and the hard 1,800-attempt ceiling reserves **$4.954521600**, both
within the approved fresh $5 cap. All reservations survive failures. Usage-based
estimates are separate from these conservative reservations and are not invoices.

This check fetched public documentation only, without credentials or inference.
