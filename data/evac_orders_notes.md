# Official evacuation times: research notes

These notes go with `data/evac_orders.csv` (15 rows: Park 4, Eaton 7, Palisades 4; 14 exact, 1 approx).

## Read this first: how the times were checked

- **Network limits.** This session could open only CAL FIRE pages (`www.fire.ca.gov`) directly. A request to allow more sites was rejected. So the other sources (LA County PDFs, the LAFD report, news, X posts) were read through **search-engine excerpts** of those pages, not by opening them. Every CSV quote is wording that appeared in those excerpts, and every time was seen in at least two separate searches or confirmed another way. Even so, **someone should open each `source_url` once and check the quote wording before the numbers go on a poster or slide.**
- **X (Twitter) post times** were checked independently. The time is coded inside each post ID ("snowflake" ID), and I decoded it. For example, the Butte County Sheriff post that says "5:52 p.m." was posted at 5:53 PM PDT.
- **What counts as a CSV row.** I only included times that a source gives as the time the order or warning was *issued*, or times taken from the official alert itself (sheriff or city post).
- **What does not count.** CAL FIRE incident-update pages only list zones that are "in effect" at the moment of each update. That gives a latest-possible time (an upper bound), not the time the order went out. Using it as the order time would make Emberline look better than it really is. So these upper bounds are in the tables below, **not** in the CSV. All 245 CAL FIRE updates inside the three data windows were downloaded and parsed.
- **Header change.** The old template had 5 columns. The CSV now uses the requested 8 columns. `app/backend/store.py`, `src/p3_outputs.py` and `app/static/js/timeline.js` read columns by name (`fire_id`, `town`, `order_type`, `order_time_utc`, `source_url`), so they still work. Side note: `timeline.js` labels every row "official evacuation order", even rows that are warnings.

---

## Park Fire (park_fire_2024)

**Found**
- **Chico, warning:** 24 Jul 4:45 PM PDT, exact. Zones 317 and 318 (CAL FIRE code BUT-CNE), the area north and northwest of Bidwell Park. Source: Sacramento Bee story syndicated on Yahoo. Only those two zones, not the city itself.
- **Chico, order:** about 5:15 PM PDT, **approx**. The same story says the 4:45 PM warning was "updated to an order about 30 minutes later" (according to the Sheriff's social media). 5:15 is 4:45 plus about 30 minutes, worked out by me, not printed in the story. The CAL FIRE update at 5:45 PM is the first to show BUT-CNE-317/318 as orders, so the two sources agree.
- **Cohasset, order:** 24 Jul 5:52 PM PDT, exact. Butte County Sheriff X post: orders for zones 250, 251, 313 and 312 "in Cohasset".
- **Butte Meadows, order:** 26 Jul 3:00 PM PDT, exact. Sheriff X post upgrading zones 236 and 237 from warning to order. These zones are BUT-BM-236 and BUT-BM-237: CAL FIRE update lists show them changing from warning to order, and Butte County's "Butte Meadows Evacuation Map" uses the BUT-BM codes.

**Not found (no issue time in any source I could reach)**
- Cohasset warning (zones 252 and 253 were already warnings by 5:45 PM on 24 Jul).
- Forest Ranch warning and order.
- Magalia warning (no Magalia order inside the window).
- Butte Meadows warning.
- Butte Creek Canyon and Butte Valley: I could not even tell which zone codes cover them (BUT-CH-120/149/150, BUT-CSE and BUT-TOP are possibilities, unconfirmed).
- The Sheriff's other posts from 24–25 Jul are not indexed by the search engine. Facebook and the Sheriff's website could not be reached.

**Conflicts and doubts**
- **Cohasset 5:52 PM may not be the first order.** The same Yahoo story says deputies also upgraded zones 252 and 253 in Cohasset from warning to order, but gives no time. CAL FIRE still listed 252 and 253 as warnings at 5:45 PM and as orders at 6:46 PM, so that upgrade happened at about the same time as the 5:52 PM order. I used 5:52 because it is the only Cohasset order with a published time.
- **Zones 312 and 313.** The Sheriff calls them "in Cohasset", but CAL FIRE codes them BUT-CNE (Chico northeast). I kept the Sheriff's place name.
- **Butte Meadows zone 235.** CAL FIRE shows BUT-BM-235 as an order at 3:35 PM on 26 Jul (it was a warning at 2:48 PM). No source gives its exact time, so 235 could have been ordered a few minutes before or after the 3:00 PM post. 3:00 PM is the earliest Butte Meadows order time I found.
- **Order versus warning for 317/318.** CBS Sacramento lists BUT-CNE 317-318 as "mandatory evacuations". That is the status later in the day. It fits the Yahoo sequence: warning at 4:45, order about 30 minutes later.

**CAL FIRE upper bounds** (first update that lists the zone type; previous update in brackets)

| Town (zone prefix) | Order first listed | Warning first listed |
|---|---|---|
| Chico (BUT-CNE) | 24 Jul 5:45 PM (4:45 PM) | 24 Jul 11:26 PM, other CNE zones (9:44 PM) |
| Cohasset (BUT-COH) | 24 Jul 6:46 PM (6:08 PM) | 24 Jul 5:45 PM (4:45 PM) |
| Forest Ranch (BUT-FR) | 24 Jul 11:26 PM (9:44 PM) | 24 Jul 6:46 PM (6:08 PM) |
| Magalia (BUT-MA) | none in window | 25 Jul 4:14 PM (1:18 PM) |
| Butte Meadows (BUT-BM) | 26 Jul 3:35 PM (2:48 PM) | 26 Jul 12:29 PM (12:18 PM) |

---

## Eaton Fire (eaton_fire_2025)

Main source: the Citygate Associates "Investigation Report of the Eaton Fire Evacuation Alerts" (revised final, 18 May 2026, file.lacounty.gov 1208708). It gives zone-level issue times. These agree with the McChrystal Group after-action review (Sept 2025; synopsis PDF 1192777). They also agree with the CAL FIRE lists: every Citygate time falls just before the first CAL FIRE update that shows those zones.

**Found**
- **Altadena, order:** 7:26 PM PST on 7 Jan. Five Altadena zones east of Lake Ave.
- **Pasadena, order:** 7:26 PM. One Pasadena zone (PAS-E019).
- **Altadena, warning:** 7:55 PM. One Altadena zone just east of Lake Ave.
- **Sierra Madre, order:** 9:26 PM. Two Sierra Madre zones.
- **Arcadia, order:** 11:11 PM. Three zones (ARC-001, 002, 004).
- **Arcadia, warning:** 11:17 PM. ARC-003 and ARC-005.
- **Monrovia, warning:** 11:17 PM. One Monrovia zone (MRV-101).

**Not counted on purpose**
- **6:48 PM advisory.** The county sent an "advisory" to 12 zones (Pasadena/Eaton Canyon, north of I-210, Altadena east of Lake) telling people to "BE ALERT AND MONITOR". It was not an evacuation warning, so it is not in the CSV. You may want to mention it, because it was the first public alert.
- **West Altadena.** Orders for 13 Altadena zones west of Lake Ave went out at 3:25 AM on 8 Jan. A square-mile pocket of southwest Altadena got its order at 5:42 AM (Washington Post, NBC). These matter for the story (17 of the deaths were there) but are not the *first* Altadena order.

**Not found (time unknown)**
- **Pasadena, warning.** CAL FIRE already lists PAS-E014 to E018 as warnings at 7:39 PM. Citygate's 10:43 PM warnings were for "2 additional" Pasadena zones, so they were not the first.
- **Sierra Madre, warning.** CAL FIRE lists 14 Sierra Madre warning zones by 8:57 PM (none at 8:28 PM). The 11:17 PM warning was "1 additional" zone, so it was not the first.
- **Monrovia, order.** Probably 4:47 AM on 8 Jan for 17 Monrovia zones. One search excerpt credited this to the Citygate report, and CAL FIRE's 4:50 AM update lists exactly 17 Monrovia order zones (MRV-101 to MRV-405), which strongly supports it. I left it out of the CSV because I could not get the report's exact wording for a quote. Worth checking in the PDF.
- **La Cañada Flintridge.** Citygate says Unified Command decided at 2:18 AM on an order for the "La Cañada/Flintridge-JPL" zone plus warnings for 6 LCF zones, and the orders were sent by 3:25 AM. The counts in the county documents do not match each other. Other evidence:
  - CAL FIRE lists 7 LCF order zones by 4:50 AM and 10 warning zones by 5:05 AM.
  - Pasadena Now says the Sheriff ordered LCF residents out "at 5:30 a.m.".
  - A Crescenta Valley Sheriff X post ("Evacuation Order Issued for All of La Cañada Flintridge") was posted at 5:11 AM PST.

  These do not agree, so no LCF row.
- **Glendale.** CAL FIRE upper bounds: order by 5:19 AM, warning by 5:59 AM on 8 Jan. A KNX X post at 9:42 AM about Chevy Chase and Glenoaks canyons came later.
- **La Crescenta-Montrose.** Warning by 5:59 AM on 8 Jan (CRV zones). No order in window.
- **Bradbury and Duarte.** Warnings by 5:05 AM on 8 Jan (not listed at 4:54 AM). No order in window.
- **East Pasadena, San Pasqual, San Marino, South Pasadena, Temple City, East San Gabriel.** No order or warning found in the window. CAL FIRE lists no zones named for them. A few unincorporated "LAC-E" zones (for example LAC-E183, ordered by 9:46 PM) could not be matched to a place.
- **Kinneloa Mesa** (unincorporated, ordered at 7:26 PM) is not on our town list, so it has no row.

**Conflicts and doubts**
- **First order: 7:25 or 7:26 PM?** The county's "Eaton Fire Timeline Overview" PDF (1191567) shows the first order at 7:25 PM and also a "warning for 7 zones" around 7:26 or 7:55 PM. That PDF's text comes out jumbled, so I used Citygate (later, revised, zone by zone): order 7:26, warning 7:55. CAL FIRE's 7:25 PM update already lists PAS-E019, which fits within a minute.
- **CAL FIRE flips two zones.** Between 7:27 and 8:09 PM, CAL FIRE lists ALD-MENDOCINO and ALD-MOUNTLOWE as orders, then as warnings. Citygate says 1 Altadena warning zone at 7:55. I trusted Citygate.
- **Start time.** Sources give 6:15, 6:18, 6:20 or 6:23 PM. This does not affect the CSV.
- **Disputed messages.** Citygate's May 2026 revision says the disputed 11:24 PM messages concerned Sierra Madre, not a westward expansion. The Citygate and McChrystal zone counts for 9:00 and 10:30 PM do not match each other.

---

## Palisades Fire (palisades_fire_2025)

**Found**
- **Pacific Palisades (Los Angeles), warning:** 11:12 AM PST on 7 Jan. AP found a wireless emergency alert at 11:12 that told residents to be ready to evacuate. The LAFD after-action report puts a "Be Aware" alert right after its 11:12 entry. A city Nixle message at 11:13 told nearby residents to "get set" for a possible evacuation. The LAFD calls it a "Be Aware" alert, not a formal "Evacuation Warning". I classed it as a warning because it said "be ready to evacuate".
- **Pacific Palisades (Los Angeles), order:** 12:07 PM. Three sources agree: the LAFD after-action report ("at 1207 hours", covering Merrimac Rd west to Topanga Canyon Blvd and south to PCH), the AP analysis, and an LAFD Nixle alert stamped 12:07 PM PST.
- **Santa Monica, order:** 7:38 PM. City of Santa Monica X post ("is issuing an Evacuation Order ... north of San Vicente"), time decoded from the post ID.
- **Santa Monica, warning:** 7:46 PM. Santa Monica Police X post ("An Evacuation Warning has been issued for all areas ..."). The city press release says the warning area is north of Montana Ave.

**Not found (time unknown)**
- **Topanga.** CAL FIRE lists TOP-U007 and U009 as warnings by 11:44 AM. The McChrystal review says the county's first Palisades alert was at 11:30 AM, a warning for **Sunset Mesa**. I could not confirm that the Topanga zones were part of that alert. For orders:
  - CAL FIRE's 4:56 PM update says "An EVACUATION ORDER has been issued for Topanga west of Tuna Canyon Rd".
  - CAL FIRE lists TOP-U002 to U009 as orders by 5:48 PM.
  - SFGate says orders were issued "at around 12:30 p.m." for residents at the southern end of Topanga Canyon Blvd. That is probably the LA city order, whose western edge is that road, so I did not use it for Topanga.
  - The exact times should be in Appendix 10 of the McChrystal review (file.lacounty.gov/SDSInter/bos/supdocs/207915.pdf), which I could not read.
- **Malibu.** CAL FIRE bounds: MAL-C111-B warning by 12:20 PM and order by 1:24 PM. Official posts I found came later than CAL FIRE's lists:
  - City of Malibu X post for a MAL-C111-A warning at 2:06 PM PST.
  - City news flash "Update 1/7/25, 7:45 PM" for new orders in MAL-C111-A and RMB-U030-A.
  - The city's MAL-C111-B news flash shows only a date.
- **Calabasas.** CAL FIRE lists warnings for CAL-C405 to C415 by 5:59 PM. The city website (6:34 PM) and city X post (6:35 PM) say "LA County Fire issued evacuation warnings for all Zones in Calabasas south of the 101". Both are later than CAL FIRE, so not used. No order in window.
- **Pepperdine University.** No order or warning tied to the campus. Pepperdine said at 8:11 PM PST that the fire was "not currently a threat to campus". Zone MAL-C112 had a warning by 5:59 PM, but I did not confirm that it includes the campus.
- **Hidden Hills and Bell Canyon.** Nothing found for the Palisades Fire. Careful: orders there on 9 Jan were for the **Kenneth Fire** (West Hills), a different fire. Do not mix them in.
- **Sunset Mesa** (unincorporated, not on our list): warning at 11:30 AM (McChrystal review). Order by 12:00 PM (CAL FIRE).

**Conflicts and doubts**
- **Pacific Palisades order.** CAL FIRE's update stamped 12:00 PM already says "Evacuation Orders have been established for the fire area all the way down to the Pacific Coast Highway", 7 minutes before 12:07. Press reports of an independent report give "12:09 p.m.". I used 12:07 because it is the official alert time and three sources agree on it.
- **Santa Monica order.** One search excerpt said a Santa Monica Daily Press article on the order was time-stamped 7:31 PM. If so, the order went out a few minutes before the city's 7:38 PM post. I could not confirm this. The city's press release came later (about 9:13 PM).
- **Santa Monica warning.** It may have been issued at the same time as the order. 7:46 PM is simply the first time it was published.

**CAL FIRE upper bounds** (first update that lists the zone type)

| Town (prefix) | Order | Warning |
|---|---|---|
| Topanga (TOP) | text at 4:56 PM, zones at 5:48 PM | 11:44 AM (none at 11:31) |
| Malibu (MAL) | 1:24 PM (none at 12:37) | 12:20 PM (none at 12:19) |
| Calabasas (CAL) | none in window | 5:59 PM (none at 5:48) |
| City of LA (LOS-Q0767) | 12:37 PM | n/a |
| Santa Monica (likely the SAN-Q1395/1396 zones, unconfirmed) | 8:19 PM, plus text at 8:26 PM | 8:19 PM |


## Review by the team (lead)

* Removed the Chico evacuation ORDER row ("about 5:15 PM"): that time was worked out from "about 30 minutes after the 4:45 PM warning", not published as a time. We only use times a source states.
* Pacific Palisades is part of the City of Los Angeles, not a separate Census place, so it is not in our town list. Its times are shown in the app as context, not compared.
* The quotes in the CSV were taken from search results (the research machine could not open most pages). Open each source link once before presenting the comparison.
