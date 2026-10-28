# At 10× today's volume, what breaks first?

**The free-tier rate limit breaks first. Today's busiest minute had 2 requests, so 10× is 20 model calls a minute, against a measured cap of 15 (`GenerateRequestsPerMinutePerProjectPerModel-FreeTier=15`: 20 concurrent calls → 3 × 429, each told to retry in 40 s). Cost at 10× is only $0.06 a day.**

---

The evidence behind that line:

| | Today | 10× | Limit | Breaks? |
|---|---|---|---|---|
| Requests per weekday | 22.4 | 224 | – | – |
| **Busiest minute** | **2** | **20** | **15 / min** (provider, measured) · 9.2 / min (the app's own throttle, 6.5 s apart) | **yes** |
| Busiest hour | 7 | 70 | 900 / h | no |
| Cost per day, `rag-answer@3`, uncached ($0.000257 per query) | $0.006 | **$0.058** | – | no |
| Service latency p95, excluding the queue | 3.6 s | 3.6 s, plus queueing | – | only through the queue |

- **"Today"** is the replayed traffic week in `logs/requests/`: 161 requests, with the peaks from `npm run logs -- slices --until "2026-10-27 23:59"`. The requests are real; the arrival times are simulated.
- **The cap comes from Google's own 429.** The 20 concurrent calls are in [burst-20.txt](./burst-20.txt). Free-tier limits are published only inside AI Studio, which is why it was measured.
- **What a breach looks like.** With the app's throttle, the 20th request of a peak minute starts about 19 × 6.5 s = 124 s late. Without the throttle, 5 of the 20 get a 429 and wait at least 40 s. Either way the symptom is latency, and the cause is the rate limit. Cost never comes close to mattering.
- **Not measured: the daily request cap.** Measuring it would mean using up a day's quota. 224 requests a day at 10×, plus about 40 calls for each suite run, should be checked against the RPD shown in AI Studio.

## The plan

1. **Answer cache.** Already shipped, and −52% generation calls on the replayed termination traffic ([cost_by_stage.md](./cost_by_stage.md)). It brings 20 a minute down to about 10, under the provider's cap.
2. **Set the throttle to the cap that was measured.** The 6.5 s spacing was sized for a guessed 10 RPM. The measured cap is 15, so `LLM_MIN_INTERVAL_MS=4100` gives 14.6 calls a minute.
3. **Turn on billing.** At $0.06 a day for 10× traffic, Tier 1 removes the free-tier cap for under $2 a month. This is the real fix. Items 1 and 2 only buy time on the free tier.
4. **Keep the suite off production's quota.** One suite run is 34–40 calls, and it draws from the same 15 a minute.
