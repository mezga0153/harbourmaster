// The questions asked of the play log, by stats.sh and by the stats page.
// Each reads d (the days of games), v (the visits) and g (the games) within
// the chosen stretch of time (db.mjs puts them in front of every one). `page`
// ones are only drawn on the page, being long lists of numbers rather than
// something to read as a table. The Visitors tab's (`tab: 'visitors'`) read
// the visits. `needs` names what a section reads that came with a later
// migration, so that a database without it yet only goes without that
// section (db.mjs).

// the game's own addresses: a visit from one of them came from the game itself
const HOSTS = `'harbourmaster.tinetov.net', 'localhost', '127.0.0.1'`;
// what holds the port back as a day ends: no cargo wanted, the boats unloaded
// too slowly, the trucks taking it away too slowly, or nothing
const LIMIT = `CASE WHEN json_extract(capacity, '$.demand') = 0 THEN 'no cargo coming'
                    WHEN json_extract(capacity, '$.unloading') < json_extract(capacity, '$.demand') THEN 'unloading'
                    WHEN json_extract(capacity, '$.trucking') < json_extract(capacity, '$.demand') THEN 'trucking'
                    ELSE 'keeping up' END`;

export const SECTIONS = [
  {
    id: 'overview',
    title: 'Overview',
    sql: `SELECT (SELECT COUNT(*) FROM g) AS games, (SELECT COUNT(*) FROM g WHERE game IN (SELECT game FROM v WHERE day0 = 1)) AS new_games,
                 SUM(done) AS days, ROUND(SUM(seconds) / 3600.0, 1) AS hours, ROUND(SUM(paused) * 100.0 / MAX(1, SUM(seconds))) AS paused_pct,
                 ROUND(SUM(fast) * 100.0 / MAX(1, SUM(seconds))) AS fast_pct,
                 (SELECT COUNT(DISTINCT game) FROM d WHERE tier >= 1) AS tier1_games, (SELECT COUNT(DISTINCT game) FROM d WHERE bankrupt) AS bankrupt,
                 ROUND(AVG(fps)) AS fps
          FROM d`,
  },
  {
    id: 'daily',
    title: 'Games by day',
    page: true,
    sql: `SELECT date(created_at / 1000, 'unixepoch') AS date, COUNT(DISTINCT game) AS games, SUM(done) AS days,
                 ROUND(SUM(seconds) / 3600.0, 2) AS hours
          FROM d GROUP BY date ORDER BY date`,
  },
  {
    id: 'reach',
    title: 'How far games get (the furthest day of each game)',
    sql: `SELECT CASE WHEN far = 1 THEN '1' WHEN far = 2 THEN '2' WHEN far <= 4 THEN '3-4' WHEN far <= 9 THEN '5-9'
                      WHEN far <= 19 THEN '10-19' WHEN far <= 49 THEN '20-49' ELSE '50+' END AS furthest_day,
                 COUNT(*) AS games
          FROM g GROUP BY furthest_day ORDER BY MIN(far)`,
  },
  {
    id: 'retention',
    title: 'Games still going on each day',
    page: true,
    sql: `SELECT day, COUNT(DISTINCT game) AS games FROM (SELECT game, day FROM d UNION SELECT game, day FROM v WHERE game IS NOT NULL AND NOT bot)
          WHERE day <= 100 GROUP BY day ORDER BY day`,
  },
  {
    id: 'tiers',
    title: 'When games reach each tier (the day, and the hours played before it)',
    sql: `SELECT tier, COUNT(*) AS games, MIN(first) AS earliest_day, ROUND(AVG(first), 1) AS average_day, MAX(first) AS latest_day,
                 ROUND(AVG(before) / 3600.0, 1) AS hours_before
          FROM (SELECT game, tier, MIN(day) AS first, MIN(played - seconds) AS before
                FROM (SELECT game, tier, day, seconds, SUM(seconds) OVER (PARTITION BY game ORDER BY day) AS played FROM d)
                GROUP BY game, tier)
          GROUP BY tier ORDER BY tier`,
  },
  {
    id: 'curve',
    title: 'The port as games go on: averages over the games that got to each day (days ended)',
    sql: `SELECT CASE WHEN day <= 20 THEN day WHEN day <= 50 THEN (day - 1) / 5 * 5 + 1 ELSE (day - 1) / 10 * 10 + 1 END AS from_day,
                 COUNT(DISTINCT game) AS games, ROUND(AVG(cash)) AS cash, ROUND(AVG(income)) AS income, ROUND(AVG(spend)) AS spend,
                 ROUND(AVG(loan)) AS loan, ROUND(AVG(tier), 2) AS tier, ROUND(AVG(staff), 1) AS staff, ROUND(AVG(contracts), 1) AS contracts,
                 ROUND(AVG(town_pop)) AS town, ROUND(AVG(in_red > 0) * 100) AS in_red_pct, ROUND(AVG(seconds) / 60, 1) AS minutes
          FROM d WHERE done GROUP BY from_day ORDER BY from_day`,
  },
  {
    id: 'money',
    title: 'Money trouble: games that ended days in the red, and went bankrupt',
    sql: `SELECT (SELECT COUNT(DISTINCT game) FROM d) AS games, (SELECT COUNT(DISTINCT game) FROM d WHERE in_red > 0) AS ever_in_red,
                 (SELECT COUNT(DISTINCT game) FROM d WHERE loan > 0) AS took_a_loan, (SELECT COUNT(DISTINCT game) FROM d WHERE bankrupt) AS bankrupt,
                 (SELECT ROUND(AVG(first)) FROM (SELECT MIN(day) AS first FROM d WHERE in_red > 0 GROUP BY game)) AS first_red_day,
                 (SELECT ROUND(AVG(first)) FROM (SELECT MIN(day) AS first FROM d WHERE bankrupt GROUP BY game)) AS bankrupt_day`,
  },
  {
    id: 'limits',
    title: 'What holds ports back, by tier (as each day ends)',
    sql: `SELECT tier, ${LIMIT} AS held_back_by, COUNT(*) AS days, COUNT(DISTINCT game) AS games,
                 ROUND(AVG(json_extract(capacity, '$.congestion')) * 100) AS congestion_pct
          FROM d WHERE done GROUP BY tier, held_back_by ORDER BY tier, days DESC`,
  },
  {
    id: 'problems',
    title: 'Red marks on the map (as days end): what cannot work as built',
    sql: `SELECT j.key AS problem, COUNT(DISTINCT d.game) AS games, COUNT(*) AS days, SUM(j.value) AS marks
          FROM d, json_each(d.problems) j GROUP BY problem ORDER BY games DESC, days DESC LIMIT 30`,
  },
  {
    id: 'bad',
    title: 'Bad news and refusals: the messages in red',
    sql: `SELECT j.key AS message, COUNT(DISTINCT d.game) AS games, SUM(j.value) AS times
          FROM d, json_each(d.bad) j GROUP BY message ORDER BY games DESC, times DESC LIMIT 40`,
  },
  {
    id: 'actions',
    title: 'What players do (built, bought, hired, signed, the screens opened)',
    sql: `SELECT j.key AS action, COUNT(DISTINCT d.game) AS games, SUM(j.value) AS times,
                 ROUND(AVG(d.day), 1) AS average_day
          FROM d, json_each(d.actions) j GROUP BY action ORDER BY games DESC, times DESC LIMIT 60`,
  },
  {
    id: 'firstday',
    title: 'The first day: what new players do',
    sql: `SELECT j.key AS action, COUNT(DISTINCT d.game) AS games, SUM(j.value) AS times
          FROM d, json_each(d.actions) j WHERE d.day = 1 GROUP BY action ORDER BY games DESC, times DESC LIMIT 30`,
  },
  {
    id: 'tips',
    title: 'The advisor’s tips, and the day they came up',
    sql: `SELECT j.value AS tip, COUNT(DISTINCT d.game) AS games, MIN(d.day) AS earliest_day, ROUND(AVG(d.day), 1) AS average_day
          FROM d, json_each(d.tips) j GROUP BY tip ORDER BY average_day`,
  },
  {
    id: 'pace',
    title: 'How games are played: paused, sped up, and how long a day takes (days ended)',
    sql: `SELECT tier, COUNT(*) AS days, ROUND(AVG(seconds) / 60, 1) AS minutes_a_day,
                 ROUND(SUM(paused) * 100.0 / MAX(1, SUM(seconds))) AS paused_pct, ROUND(SUM(fast) * 100.0 / MAX(1, SUM(seconds))) AS fast_pct
          FROM d WHERE done GROUP BY tier ORDER BY tier`,
  },
  {
    id: 'slow',
    title: 'Frames a second, by device and graphics card (the slowest first)',
    sql: `SELECT COALESCE(vs.device, '?') AS device, COALESCE(vs.gpu, '?') AS gpu, vs.graphics, COUNT(*) AS days,
                 ROUND(AVG(d.fps)) AS fps, ROUND(MIN(d.fps)) AS worst
          FROM d JOIN visits vs ON vs.visit = d.visit WHERE d.fps IS NOT NULL
          GROUP BY device, gpu, vs.graphics ORDER BY fps LIMIT 25`,
  },
  {
    id: 'errors',
    title:
      'Errors players have hit, most often first (every one sent: the time span does not apply)',
    sql: `SELECT kind, message, COUNT(*) AS times, COUNT(DISTINCT COALESCE(game, visit)) AS games,
                 datetime(MAX(created_at) / 1000, 'unixepoch') AS last
          FROM errors GROUP BY kind, message ORDER BY times DESC LIMIT 40`,
  },
  {
    id: 'errorlog',
    title: 'The latest errors, with where and on what',
    page: true,
    sql: `SELECT datetime(created_at / 1000, 'unixepoch') AS at, kind, message, game, day, build, device, stack
          FROM errors ORDER BY id DESC LIMIT 30`,
  },
  {
    id: 'games',
    title: 'Latest games',
    page: true,
    sql: `SELECT g.game, g.seed, g.far AS day, (SELECT MAX(tier) FROM d WHERE d.game = g.game) AS tier,
                 (SELECT cash FROM d WHERE d.game = g.game ORDER BY day DESC LIMIT 1) AS cash,
                 (SELECT town_pop FROM d WHERE d.game = g.game ORDER BY day DESC LIMIT 1) AS town,
                 (SELECT ROUND(SUM(seconds) / 60.0) FROM d WHERE d.game = g.game) AS minutes,
                 (SELECT MAX(bankrupt) FROM d WHERE d.game = g.game) AS bankrupt,
                 g.visits, g.first, g.last
          FROM g ORDER BY g.last DESC LIMIT 40`,
  },
  {
    id: 'gamewhere',
    title: 'Where and on what the latest games were played',
    page: true,
    sql: `SELECT game, MAX(device) AS device, MAX(city) AS city, MAX(country) AS country, MAX(touch) AS touch
          FROM v WHERE game IS NOT NULL GROUP BY game ORDER BY MAX(updated_at) DESC LIMIT 60`,
  },

  // ---- the visitors (the Visitors tab; ./stats.sh visits): v is the visits
  // in the stretch of time, each a page load of the game. Bots are left out
  // but for the count of them.
  {
    id: 'visitors',
    title: 'Visitors',
    tab: 'visitors',
    sql: `SELECT COUNT(*) AS visits, SUM(bot) AS bots, SUM(NOT bot AND started) AS started, SUM(NOT bot AND played) AS played,
                 SUM(NOT bot AND day0 = 1) AS new_games, ROUND(AVG(CASE WHEN NOT bot THEN seconds END)) AS avg_secs,
                 SUM(NOT bot AND ref_host IS NOT NULL AND ref_host NOT IN (${HOSTS})) AS from_elsewhere,
                 (SELECT COUNT(DISTINCT country) FROM v WHERE NOT bot) AS countries,
                 SUM(NOT bot AND touch) AS on_touch
          FROM v`,
  },
  {
    id: 'vdaily',
    title: 'Visits by day',
    tab: 'visitors',
    page: true,
    sql: `SELECT date(created_at / 1000, 'unixepoch') AS date, COUNT(*) AS visits, SUM(started) AS started, SUM(played) AS played
          FROM v WHERE NOT bot GROUP BY date ORDER BY date`,
  },
  {
    id: 'funnel',
    title: 'How far visits get',
    tab: 'visitors',
    sql: `SELECT COUNT(*) AS visits, SUM(started) AS game_on, SUM(played) AS did_something, SUM(actions >= 20) AS twenty_actions,
                 SUM(day > day0) AS saw_a_day_end, SUM(day > day0 + 4) AS five_days,
                 ROUND(AVG(played) * 100) AS played_pct
          FROM v WHERE NOT bot`,
  },
  {
    id: 'stays',
    title: 'How long visits stay (the page in view)',
    tab: 'visitors',
    sql: `SELECT CASE WHEN seconds < 10 THEN 'under 10 s' WHEN seconds < 60 THEN '10-60 s' WHEN seconds < 300 THEN '1-5 min'
                      WHEN seconds < 1200 THEN '5-20 min' WHEN seconds < 3600 THEN '20-60 min' ELSE 'an hour+' END AS stayed,
                 COUNT(*) AS visits, SUM(played) AS played
          FROM v WHERE NOT bot GROUP BY stayed ORDER BY MIN(seconds)`,
  },
  {
    id: 'returning',
    title: 'Coming back: visits that carried on a game from before',
    tab: 'visitors',
    sql: `SELECT CASE WHEN day0 = 1 THEN 'a new game' WHEN day0 IS NULL THEN 'no game' ELSE 'carried on a game' END AS opened,
                 COUNT(*) AS visits, SUM(played) AS played, ROUND(AVG(seconds) / 60, 1) AS minutes
          FROM v WHERE NOT bot GROUP BY opened ORDER BY visits DESC`,
  },
  {
    id: 'referrers',
    title: 'Where visitors come from (the referring site)',
    tab: 'visitors',
    sql: `SELECT CASE WHEN ref_host IS NULL THEN '(none: typed, or an app)' WHEN ref_host IN (${HOSTS}) THEN '(the game itself)'
                      ELSE ref_host END AS came_from,
                 COUNT(*) AS visits, SUM(started) AS started, SUM(played) AS played, ROUND(AVG(played) * 100) AS played_pct
          FROM v WHERE NOT bot GROUP BY came_from ORDER BY visits DESC LIMIT 25`,
  },
  {
    id: 'refpages',
    title: 'The pages they come from, and utm tags',
    tab: 'visitors',
    sql: `SELECT referrer, COUNT(*) AS visits, SUM(played) AS played FROM v
          WHERE NOT bot AND referrer IS NOT NULL AND ref_host NOT IN (${HOSTS}) GROUP BY referrer ORDER BY visits DESC LIMIT 25`,
  },
  {
    id: 'landings',
    title: 'Where they land (the address, with any utm tags)',
    tab: 'visitors',
    sql: `SELECT page, COUNT(*) AS visits, SUM(played) AS played FROM v
          WHERE NOT bot GROUP BY page ORDER BY visits DESC LIMIT 25`,
  },
  {
    id: 'countries',
    title: 'Where visitors are: countries',
    tab: 'visitors',
    sql: `SELECT COALESCE(country, '?') AS country, COUNT(*) AS visits, SUM(played) AS played, ROUND(AVG(played) * 100) AS played_pct,
                 COUNT(DISTINCT city) AS cities
          FROM v WHERE NOT bot GROUP BY country ORDER BY visits DESC LIMIT 30`,
  },
  {
    id: 'cities',
    title: 'Where visitors are: cities',
    tab: 'visitors',
    sql: `SELECT COALESCE(city, '?') AS city, region, COALESCE(country, '?') AS country, COUNT(*) AS visits, SUM(played) AS played
          FROM v WHERE NOT bot GROUP BY city, region, country ORDER BY visits DESC LIMIT 30`,
  },
  {
    id: 'devices',
    title: 'On what: devices',
    tab: 'visitors',
    sql: `SELECT COALESCE(device, '?') AS device, COUNT(*) AS visits, SUM(started) AS started, SUM(played) AS played,
                 ROUND(AVG(played) * 100) AS played_pct
          FROM v WHERE NOT bot GROUP BY device ORDER BY visits DESC LIMIT 30`,
  },
  {
    id: 'screens',
    title: 'On what: screens (CSS pixels and pixel ratio), a finger or a mouse',
    tab: 'visitors',
    sql: `SELECT screen_w || 'x' || screen_h AS screen, dpr, CASE WHEN touch THEN 'finger' ELSE 'mouse' END AS pointer,
                 COUNT(*) AS visits, SUM(played) AS played
          FROM v WHERE NOT bot GROUP BY screen, dpr, pointer ORDER BY visits DESC LIMIT 20`,
  },
  {
    id: 'graphics',
    title: 'Graphics: the settings (water/shadows/resolution) and the cards',
    tab: 'visitors',
    sql: `SELECT COALESCE(graphics, '?') AS settings, COALESCE(gpu, '?') AS gpu, COUNT(*) AS visits, SUM(played) AS played
          FROM v WHERE NOT bot GROUP BY settings, gpu ORDER BY visits DESC LIMIT 25`,
  },
  {
    id: 'languages',
    title: 'Languages',
    tab: 'visitors',
    sql: `SELECT COALESCE(lang, '?') AS browser, COUNT(*) AS visits, SUM(played) AS played
          FROM v WHERE NOT bot GROUP BY browser ORDER BY visits DESC LIMIT 20`,
  },
  {
    id: 'vlatest',
    title: 'Latest visits',
    tab: 'visitors',
    page: true,
    sql: `SELECT created_at, COALESCE(ref_host, '-') AS came_from, page, device, city, country, lang, touch, game, day0, day,
                 actions, new_games, seconds, visit
          FROM v ORDER BY created_at DESC LIMIT 60`,
  },
];

// One game: every day of it, in order, with all its columns (so that a
// column the database hasn't got yet can't make it fail), the errors it hit,
// and the visits (page loads) that played it.
export const gameSections = (id) => [
  { id: 'rows', sql: `SELECT * FROM days WHERE game = '${id}' ORDER BY day` },
  { id: 'errors', sql: `SELECT * FROM errors WHERE game = '${id}' ORDER BY id` },
  {
    id: 'visits',
    sql: `SELECT * FROM visits WHERE game = '${id}' OR visit IN (SELECT visit FROM days WHERE game = '${id}') ORDER BY id`,
  },
];
