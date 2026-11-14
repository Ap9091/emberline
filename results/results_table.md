# Emberline - final test results (2024-2025 fires, never seen in training)

Test fires: 18. Forecasts made: 1036 fire-hours. Main model: `logreg`. Cut-offs chosen without test fires: town warning {'logreg': 0.01, 'hgb': 0.01, 'average': 0.01, 'hgb_direct': 0.01}; squares {'logreg': {'burn': 0.625, 'new': 0.275}, 'hgb': {'burn': 0.8, 'new': 0.3}, 'average': {'burn': 0.675, 'new': 0.3}, 'hgb_direct': {'burn': 0.8, 'new': 0.3}}.

This is our second test run; the first (with three bugs, see the notebook) is in `phase3_run1_results_table.md`.

## Main table

|             |   towns_reached |   towns_warned |   town_recall |   people_warned |   mean_lead_h |   false_alarms_per_fire_day |   towns_warned_never_reached |   F1 all |   F1 all (2km) |   P new |   R new |   F1 new |   F1 new (2km) |   IoU +1h |   IoU +2h |   IoU +3h |
|:------------|----------------:|---------------:|--------------:|----------------:|--------------:|----------------------------:|-----------------------------:|---------:|---------------:|--------:|--------:|---------:|---------------:|----------:|----------:|----------:|
| persistence |              20 |              0 |          0    |               0 |       nan     |                       0     |                            0 |    0.845 |          0.953 | nan     |   0     |    0     |          0     |     0.702 |     0.559 |     0.473 |
| grow_1km    |              20 |             18 |          0.9  |          485286 |         2.5   |                      23.398 |                           42 |    0.546 |          0.844 |   0.079 |   0.833 |    0.144 |          0.242 |     0.307 |     0.193 |     0.171 |
| logreg      |              20 |             18 |          0.9  |          485286 |         2.778 |                      30.139 |                           56 |    0.827 |          0.956 |   0.266 |   0.389 |    0.316 |          0.406 |     0.679 |     0.537 |     0.45  |
| hgb         |              20 |             17 |          0.85 |          463030 |         2.765 |                      27.544 |                           57 |    0.819 |          0.954 |   0.242 |   0.447 |    0.314 |          0.427 |     0.662 |     0.522 |     0.44  |
| average     |              20 |             17 |          0.85 |          463030 |         2.765 |                      28.981 |                           55 |    0.829 |          0.956 |   0.276 |   0.413 |    0.331 |          0.433 |     0.683 |     0.543 |     0.455 |
| hgb_direct  |              20 |             17 |          0.85 |          463030 |         2.588 |                      27.174 |                           52 |    0.819 |          0.954 |   0.242 |   0.447 |    0.314 |          0.427 |     0.662 |     0.5   |     0.386 |

* town_recall: of towns the fire reached (within 1 km), share warned in the 3 h before.
* F1 new: newly burning squares at +1 h, strict; (2km) = a hit may be one square (2 km) off.
* IoU: overlap of forecast and real fire area at +1/+2/+3 h (1 = perfect).

## Per test fire

| fire                            |   fire-hours | logreg: towns warned   |   logreg: false alarms |   logreg: F1 new (2km) |   logreg: IoU +3h | grow_1km: towns warned   |   grow_1km: false alarms |   grow_1km: F1 new (2km) |   grow_1km: IoU +3h | persistence: towns warned   |   persistence: false alarms |   persistence: F1 new (2km) |   persistence: IoU +3h |
|:--------------------------------|-------------:|:-----------------------|-----------------------:|-----------------------:|------------------:|:-------------------------|-------------------------:|-------------------------:|--------------------:|:----------------------------|----------------------------:|----------------------------:|-----------------------:|
| 2024_sqf_lightning_complex_2024 |           63 | 0/0                    |                      0 |                  0.264 |             0.712 | 0/0                      |                        0 |                    0.123 |               0.133 | 0/0                         |                           0 |                           0 |                  0.708 |
| airport_fire_2024               |           65 | 2/2                    |                    268 |                  0.515 |             0.434 | 2/2                      |                      234 |                    0.231 |               0.174 | 0/2                         |                           0 |                           0 |                  0.435 |
| boone_fire_2024                 |           50 | 0/0                    |                      0 |                  0.217 |             0.273 | 0/0                      |                        0 |                    0.148 |               0.097 | 0/0                         |                           0 |                           0 |                  0.296 |
| borel_fire_2024                 |           68 | 1/1                    |                     27 |                  0.529 |             0.421 | 1/1                      |                       15 |                    0.282 |               0.164 | 0/1                         |                           0 |                           0 |                  0.446 |
| bridge_fire_2024                |           69 | 2/2                    |                     36 |                  0.522 |             0.464 | 2/2                      |                       18 |                    0.326 |               0.203 | 0/2                         |                           0 |                           0 |                  0.479 |
| eaton_fire_2025                 |           47 | 3/3                    |                    356 |                  0.256 |             0.403 | 3/3                      |                      242 |                    0.234 |               0.168 | 0/3                         |                           0 |                           0 |                  0.431 |
| garnet_fire_2025                |           54 | 0/0                    |                      0 |                  0.391 |             0.447 | 0/0                      |                        0 |                    0.226 |               0.113 | 0/0                         |                           0 |                           0 |                  0.484 |
| gifford_fire_2025               |           73 | 0/0                    |                      0 |                  0.392 |             0.506 | 0/0                      |                        0 |                    0.249 |               0.247 | 0/0                         |                           0 |                           0 |                  0.504 |
| green_fire_2025                 |            6 | 0/0                    |                      0 |                  0     |             0.139 | 0/0                      |                        0 |                    0.067 |               0.03  | 0/0                         |                           0 |                           0 |                  0.167 |
| lake_fire_2024                  |           72 | 0/0                    |                      2 |                  0.169 |             0.49  | 0/0                      |                        0 |                    0.157 |               0.216 | 0/0                         |                           0 |                           0 |                  0.587 |
| line_fire_2024                  |           62 | 0/0                    |                    135 |                  0.175 |             0.351 | 0/0                      |                      114 |                    0.167 |               0.14  | 0/0                         |                           0 |                           0 |                  0.406 |
| madre_fire_2025                 |           65 | 0/0                    |                      0 |                  0.507 |             0.365 | 0/0                      |                        0 |                    0.271 |               0.158 | 0/0                         |                           0 |                           0 |                  0.351 |
| mountain_fire_2024              |           34 | 3/3                    |                    101 |                  0.624 |             0.328 | 3/3                      |                       83 |                    0.322 |               0.147 | 0/3                         |                           0 |                           0 |                  0.316 |
| orleans_complex_2025            |           60 | 0/0                    |                      0 |                  0.118 |             0.384 | 0/0                      |                        0 |                    0.073 |               0.11  | 0/0                         |                           0 |                           0 |                  0.462 |
| palisades_fire_2025             |           71 | 3/5                    |                    192 |                  0.22  |             0.535 | 3/5                      |                      145 |                    0.169 |               0.193 | 0/5                         |                           0 |                           0 |                  0.592 |
| park_fire_2024                  |           72 | 3/3                    |                    117 |                  0.49  |             0.52  | 3/3                      |                       97 |                    0.368 |               0.277 | 0/3                         |                           0 |                           0 |                  0.488 |
| salt_fire_2025                  |           50 | 0/0                    |                      0 |                  0.424 |             0.434 | 0/0                      |                        0 |                    0.244 |               0.11  | 0/0                         |                           0 |                           0 |                  0.451 |
| sites_fire_2024                 |           55 | 1/1                    |                     67 |                  0.43  |             0.48  | 1/1                      |                       62 |                    0.225 |               0.177 | 0/1                         |                           0 |                           0 |                  0.487 |

## Ablation (gradient-boosted trees, PR-AUC)

|                     |   val PR-AUC all |   val PR-AUC new squares |   test PR-AUC all |   test PR-AUC new squares |
|:--------------------|-----------------:|-------------------------:|------------------:|--------------------------:|
| all features        |           0.7901 |                   0.1685 |            0.8872 |                    0.2608 |
| no wind             |           0.7838 |                   0.1532 |            0.8849 |                    0.2082 |
| no terrain          |           0.7823 |                   0.1489 |            0.8879 |                    0.2676 |
| no wind, no terrain |           0.7756 |                   0.1461 |            0.8852 |                    0.2184 |

## Five failures

|   n | type        | fire                |   hour | what                                                                | likely reasons                                                                                                                     |
|----:|:------------|:--------------------|-------:|:--------------------------------------------------------------------|:-----------------------------------------------------------------------------------------------------------------------------------|
|   1 | MISS        | palisades_fire_2025 |     53 | Bell Canyon (pop 1,946) reached at hour 54, not warned              | wind direction changes by 71 deg within 3 h; new fire appears 13 km from the old edge (spot fire / ember jump, or a separate fire) |
|   2 | MISS        | palisades_fire_2025 |     53 | Hidden Hills (pop 1,689) reached at hour 54, not warned             | wind direction changes by 71 deg within 3 h; new fire appears 13 km from the old edge (spot fire / ember jump, or a separate fire) |
|   3 | FALSE ALARM | palisades_fire_2025 |      9 | Los Angeles (pop 3,878,704) warned at hour 9, fire never reached it | strong gusts (61 km/h): fast runs and embers                                                                                       |
|   4 | FALSE ALARM | mountain_fire_2024  |      4 | Oxnard (pop 200,616) warned at hour 4, fire never reached it        | strong gusts (87 km/h): fast runs and embers                                                                                       |
|   5 | FALSE ALARM | eaton_fire_2025     |     13 | Glendale (pop 187,823) warned at hour 13, fire never reached it     | strong gusts (112 km/h): fast runs and embers                                                                                      |

## Our reading of the failures

**Our reading of the five failures** (the automatic checks above, plus what we know about these fires):

1-2. **Bell Canyon and Hidden Hills (Palisades Fire, hour 53-54 = afternoon of 9 Jan 2025).** The fire that reached
these towns appeared about 13 km from the Palisades edge just as the wind turned by about 70 degrees. The time and place match
the **Kenneth Fire**, a separate fire that started near West Hills that afternoon. Because GOES pixels are coarse, our
6 km tracker linked it to the Palisades Fire. No spread model can forecast a new ignition, so these are tracking errors
more than forecast errors. A real fix needs official fire perimeters or finer VIIRS points to separate fires.
3. **Los Angeles (Palisades Fire, hour 9).** The city of Los Angeles is represented by ONE point (its Census centre),
and our warning threshold is very low (0.01) so that we catch 9 in 10 towns. Any square in the 6 km ring around the fire
that comes within 1 km of that point is flagged. The fire did burn inside the city limits, but nowhere near the centre point.
Big cities need neighbourhood points, not one point per city.
4. **Oxnard (Mountain Fire, hour 4, gusts 87 km/h).** Strong Santa Ana winds pushed the forecast toward the Oxnard
plain. The real fire stayed in the hills above Camarillo and never crossed onto the irrigated farmland. Our vegetation
data (WorldCover) only says "cropland", not "irrigated and hard to burn", and one weather point cannot show the winds dropping
near the coast.
5. **Glendale (Eaton Fire, hour 13, gusts 112 km/h).** In extreme wind, every square near the fire gets a probability
above our low threshold, so the warning spreads in all directions. The low threshold that catches 9 in 10 towns has
this cost.

**What this tells us:** the model is good at *where the fire edge spreads next* (Step 5: new-square F1 about 2x the grow-1km
baseline). For *town warnings* it ties the simple grow-1km rule (90% vs 90% of towns) but with more false alarms. At the
same false-alarm rate as grow-1km it warns 85% instead of 90%. Its town warnings are not better than the simple rule
yet, and we say so.
