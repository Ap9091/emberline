# Weather stress test

Same trained model, same 18 test fires, same scoring; only the weather source changes. era5 = published results (hindsight weather). forecast = archived short-range forecasts. day_before = the forecast issued about a day earlier.

| Weather | Towns warned | Lead (h) | False alarms / fire-day | Spotting new fire (F1, 2 km) | Overlap +3 h |
|---|---|---|---|---|---|
| era5 | 18/20 | 2.8 | 30.1 | 0.41 | 0.45 |
| forecast | 18/20 | 2.8 | 28.5 | 0.41 | 0.46 |
| day_before | 18/20 | 2.8 | 28.8 | 0.42 | 0.45 |

| Weather | Towns flagged before the official order | Of the towns the fire reached | Sierra Madre lead (h) |
|---|---|---|---|
| day_before | 9/9 | 5/5 | 2.4 |
| era5 | 9/9 | 5/5 | 2.4 |
| forecast | 8/9 | 5/5 | 2.4 |
