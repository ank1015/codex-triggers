export type IdeaTopic =
  | "system"
  | "developer"
  | "productivity"
  | "monitoring"
  | "personal"
  | "iphone"
  | "wild";

export const IDEA_TOPICS: ReadonlyArray<{ id: IdeaTopic; label: string }> = [
  { id: "system", label: "System" },
  { id: "developer", label: "Developer" },
  { id: "productivity", label: "Productivity" },
  { id: "monitoring", label: "Monitoring" },
  { id: "personal", label: "Personal" },
  { id: "iphone", label: "iPhone" },
  { id: "wild", label: "Wild" },
];

export type Idea = {
  id: string;
  title: string;
  description: string;
  tags: readonly IdeaTopic[];
  prompt: string;
};

export const IDEAS: readonly Idea[] = [
  {
    id: "screenshot-organizer",
    title: "Screenshot organizer",
    description:
      "New screenshots get meaningful names and are filed into category folders automatically.",
    tags: ["system"],
    prompt: `Whenever I take a screenshot, organize it for me. Watch {{screenshots folder (default: ~/Desktop)}} for new screenshots, look at what each one actually shows, give it a short meaningful name, and file it into a fitting category folder inside {{organized folder (default: ~/Screenshots)}} — things like code, design, receipts, chats.

Only handle each screenshot once, and don't touch anything else in the folder.`,
  },
  {
    id: "downloads-janitor",
    title: "Downloads janitor",
    description:
      "Every finished download is classified, renamed by its content, and filed away.",
    tags: ["system", "productivity"],
    prompt: `Keep my Downloads folder tidy for me. Whenever a download finishes in {{downloads folder (default: ~/Downloads)}}, figure out what the file is and deal with it: rename documents and PDFs after their actual content (like invoice-vercel-2026-07.pdf) and move them into {{sorted documents folder (default: ~/Documents/Sorted)}}, leave installers where they are but note what app they contain, and point out files that duplicate something already there.

Keep a small log in the Downloads folder of everything you did, and never delete anything.`,
  },
  {
    id: "disk-space-triage",
    title: "Low disk space triage",
    description:
      "When space runs low, an agent finds what grew and what is safe to delete.",
    tags: ["system"],
    prompt: `Keep an eye on my disk space, and when it runs low, investigate instead of just alerting me. Check in the background every 10 minutes or so, and when free space drops below {{threshold (default: 25 GB)}} — bother me at most once a day — dig into what's actually eating the disk: caches, node_modules, Docker, Xcode leftovers, big downloads, whatever grew recently.

Write me a report at {{report path (default: ~/Desktop/disk-triage.md)}} with specific safe-to-delete candidates, how much each would save, and the exact cleanup commands. Don't delete anything yourself.`,
  },
  {
    id: "network-change-routines",
    title: "Network change routines",
    description:
      "Joining work or home Wi-Fi kicks off your arrival routine on the Mac.",
    tags: ["system", "productivity"],
    prompt: `When my Mac changes networks, run a little routine for me. Keep watch in the background, and when I join a different network, figure out which Wi-Fi it is. On {{work network name}}: {{work routine (e.g. check CI status of my repos and summarize it into a note)}}. On {{home network name}}: {{home routine (e.g. write an end-of-day summary of today's git activity)}}.

On any other network just note the change in ~/network-log.md, and make sure one reconnect only counts once.`,
  },
  {
    id: "cache-reclaimer",
    title: "Cache reclaimer",
    description:
      "A monthly hunt for Xcode, Docker, and node_modules cache bloat.",
    tags: ["system", "developer"],
    prompt: `Once a month, hunt down the disk space my developer tools are hoarding. Run at {{schedule (default: 10:00 on the first Saturday of every month)}} and look for cache bloat: Xcode DerivedData, node_modules folders under {{code directory (default: ~/code)}} untouched for over a month, Docker images and volumes, Homebrew caches, npm and pnpm stores.

Estimate what each would reclaim and write a report to {{report path (default: ~/Desktop/cache-report.md)}} with the exact removal command per item. Don't delete anything yourself — the report is for me to review.`,
  },
  {
    id: "pr-review-sidekick",
    title: "PR review sidekick",
    description:
      "Every new pull request gets a local, runnable code review from Codex.",
    tags: ["developer"],
    prompt: `Review every new pull request on {{GitHub repository (owner/name)}} for me. When a PR is opened or marked ready for review, work in {{local checkout path}}: fetch the PR, read the full diff against its base, and review it properly — bugs, missing tests, risky changes — actually running the code or tests where that helps.

Deliver the review to {{review destination (default: post it as a single PR comment with gh)}}, specific with file and line references, most important findings first, and say plainly when the PR looks good. Never push code or approve/request changes on it. Set up whatever GitHub webhook this needs, or tell me exactly how.`,
  },
  {
    id: "issue-triager",
    title: "Issue triager",
    description:
      "New issues are reproduced locally and answered with a triage comment.",
    tags: ["developer"],
    prompt: `Triage new issues on {{GitHub repository (owner/name)}} for me. Whenever an issue is opened, work in {{local checkout path}}: check whether the report is real — search the code, try to reproduce it, look for duplicate issues — then leave one comment on the issue summarizing what you found: whether it reproduces, the likely cause with file and line, any duplicate it matches, and what's missing from the report.

Stay factual and polite, never promise timelines, and don't change code, apply labels, or close anything. Set up whatever GitHub webhook this needs, or tell me exactly how.`,
  },
  {
    id: "docs-drift-detector",
    title: "Docs drift detector",
    description:
      "Each commit is checked for README and docs claims it just broke.",
    tags: ["developer"],
    prompt: `After every commit I make in {{repository path}}, check whether I just broke the docs. Watch that repo's commits in the background, and when new ones land, look at what changed and whether it invalidated anything in README.md or {{docs folder (default: docs/)}} — removed flags, renamed commands, changed defaults, moved files, dead links.

If my working tree is clean, fix the docs as uncommitted edits for me to review; otherwise write what needs updating to docs-drift.md at the repo root. A burst of commits or a rebase should only count once, and if nothing drifted, do nothing at all.`,
  },
  {
    id: "nightly-wip-guardian",
    title: "Nightly WIP guardian",
    description:
      "Uncommitted work is summarized and saved to safety branches every night.",
    tags: ["developer", "system"],
    prompt: `Every night at {{time (default: 23:30)}}, protect whatever work I left unfinished. Look through the git repos under {{code directory (default: ~/code)}} for uncommitted changes or unpushed commits, figure out what the dangling work is, and tuck the uncommitted changes away on a safety branch named wip/<date> — without disturbing my working tree or current branch, and without pushing anywhere.

Then write me a report at {{report path (default: ~/Desktop/wip-report.md)}}: each repo, its safety branch, and one line on what the work seems to be.`,
  },
  {
    id: "overnight-prototyper",
    title: "Overnight prototyper",
    description:
      "Codex picks one idea from your ideas folder and builds a spike overnight.",
    tags: ["developer", "wild"],
    prompt: `Build me a prototype while I sleep. Every night at {{time (default: 02:00)}}, look in {{ideas folder (default: ~/ideas)}} for idea write-ups that don't yet have a prototype in {{prototypes folder (default: ~/prototypes)}}, pick one, and build a rough working spike in a new folder there — the smallest thing that demonstrates the core of the idea, with a README on what works, what's faked, and how to run it.

Log one line about it in the prototypes folder, never edit the idea files themselves, and don't work anywhere outside the prototypes folder.`,
  },
  {
    id: "daily-standup-drafter",
    title: "Daily standup drafter",
    description:
      "A ready-to-paste standup summary from your git activity, every morning.",
    tags: ["developer", "productivity"],
    prompt: `Draft my standup for me every workday morning at {{weekday mornings (default: 09:00 Monday to Friday)}}. Look at git activity since the previous workday across the repos under {{code directory (default: ~/code)}} — commits by {{my git author name or email}}, branches touched, uncommitted work in progress — and write a standup note in plain first person: what I did, what's in progress, and blockers if the work makes them obvious (like failing tests).

Put it at {{standup file (default: ~/Desktop/standup.md)}}, replacing the previous one, and don't modify any repository.`,
  },
  {
    id: "competitor-watch",
    title: "Competitor watch",
    description:
      "Competitor sites and socials checked daily and distilled into a brief.",
    tags: ["monitoring"],
    prompt: `Watch my competitors and brief me when something changes. Every day at {{time (default: 08:00)}}, check {{competitor pages to watch (blog, changelog, pricing, careers, X or LinkedIn profiles)}} — use my real browser (the agent-browser skill) since I'm logged into X and LinkedIn there. Remember what you saw last time; if nothing meaningful changed, stop quietly.

When something did change, write a short brief to {{briefs folder (default: ~/Desktop/competitor-briefs/)}}: what shipped or changed, how it compares to {{my product and its positioning}}, and a suggested response. (If I give you a {{Firecrawl API key (optional)}}, you can use their change monitoring instead of checking pages yourself.)`,
  },
  {
    id: "brand-mention-monitor",
    title: "Brand mention monitor",
    description:
      "New HN and Reddit mentions get sentiment-checked reply drafts in your voice.",
    tags: ["monitoring"],
    prompt: `Tell me whenever the internet mentions my product. Keep checking Hacker News and Reddit for {{product or brand names to watch}} every {{interval (default: 30 minutes)}}, and never tell me about the same mention twice.

For each new one, read the whole thread around it, judge the sentiment and whether a reply is even warranted, and draft a response in my voice — {{how I want to sound (e.g. helpful, founder-casual, no marketing speak)}}. Save the drafts to {{drafts folder (default: ~/Desktop/mention-replies/)}}. Never post anything anywhere; drafts are for my review.`,
  },
  {
    id: "google-reviews-monitor",
    title: "Google reviews monitor",
    description:
      "New Google reviews are logged, analyzed, and owner replies drafted.",
    tags: ["monitoring"],
    prompt: `Watch the Google reviews for my business. Every day at {{time (default: 09:00)}}, check the reviews for {{business name or Google Maps URL}} using my real browser, keeping track of which ones you've already handled.

For each new review, log the rating and text in {{reviews log (default: ~/Desktop/google-reviews.md)}} and draft an owner response next to it — {{response style (e.g. warm, apologetic when deserved, no corporate boilerplate)}}. If it ever looks like review-bombing or the rating suddenly shifts, flag that loudly at the top of the log. Never post the responses; the drafts are for me.`,
  },
  {
    id: "price-drop-sniper",
    title: "Price drop sniper",
    description:
      "Product pages are polled and real price drops verified before you buy.",
    tags: ["monitoring", "personal"],
    prompt: `Watch prices on some products for me and catch real drops. Check {{product URLs to watch}} every {{interval (default: 6 hours)}}, keep a running price history, and only bother me when a price actually falls below what it was — or below {{target price (optional)}}. If a site blocks automated checking, tell me once instead of failing silently.

When a drop happens, verify it in my real browser to make sure it's genuine and not a strikethrough gimmick, then write your recommendation — buy now or wait, and why — to {{report file (default: ~/Desktop/price-watch.md)}}. Never buy anything yourself.`,
  },
  {
    id: "marketplace-sniper",
    title: "Marketplace sniper",
    description:
      "Saved marketplace searches re-run with near-misses filtered out.",
    tags: ["monitoring", "personal"],
    prompt: `Hunt marketplace listings for me. Every {{interval (default: 2 hours between 08:00 and 22:00)}}, run my saved search — {{marketplace and search (e.g. Facebook Marketplace for "M2 Mac Mini" nearby)}} — in my real browser where I'm already logged in. Skip listings you've evaluated before, and judge new ones against what I actually want: {{criteria (budget, condition, deal-breakers)}} — rejecting the near-misses a keyword search can't catch.

For each genuine match, add the link, why it qualifies, and a draft inquiry message to {{matches file (default: ~/Desktop/marketplace-matches.md)}}. Never contact sellers yourself.`,
  },
  {
    id: "arxiv-paper-scout",
    title: "arXiv paper scout",
    description:
      "Daily arXiv sweeps filtered down to the papers actually worth reading.",
    tags: ["monitoring"],
    prompt: `Scout new arXiv papers for me every morning at {{time (default: 07:30)}}. Search for {{search terms and categories (e.g. "agent evaluation", cs.AI, cs.CL)}}, skip papers you've already reported, and judge the new ones for actual relevance to {{my research interests, in one or two sentences}} — relevance, not keyword coincidence. Skim the PDF when an abstract is ambiguous.

Append only the one or two genuinely worth reading to {{digest file (default: ~/Desktop/paper-digest.md)}}, each with a two-sentence summary and why it matters to me. If nothing clears the bar, add nothing.`,
  },
  {
    id: "youtube-podcast-watch",
    title: "YouTube & podcast watch",
    description:
      "New episodes get summarized with a worth-your-time verdict.",
    tags: ["monitoring", "personal"],
    prompt: `Watch some YouTube channels and podcasts for me: {{channels and podcasts to follow}}. Check for new episodes every {{interval (default: 1 hour)}}, and never cover the same episode twice.

For each new episode, get the transcript, summarize what it actually covers, and give me a verdict on whether it's worth my time given {{what I care about}}. Append the summaries and verdicts to {{watch log (default: ~/Desktop/episode-digest.md)}}.`,
  },
  {
    id: "flight-price-watcher",
    title: "Flight price watcher",
    description:
      "Routes you're planning are checked twice daily with booking advice.",
    tags: ["monitoring", "personal"],
    prompt: `Watch flight prices for a trip I'm planning: {{route and dates (e.g. BLR to SFO, around Oct 10-20, one stop max)}}. At {{schedule (default: 08:00 and 20:00 daily)}}, check current prices on Google Flights in my real browser and keep a running price history so the trend stays visible.

Keep {{report file (default: ~/Desktop/flight-watch.md)}} updated with the current best options and your recommendation — book now or keep waiting, based on the trend and typical pricing for the route — and make a meaningful drop unmissable at the top. Never book anything yourself.`,
  },
  {
    id: "tell-my-mac",
    title: "Tell my Mac to…",
    description:
      "Dictate anything to Siri; the agent does it on your Mac and texts back.",
    tags: ["iphone", "wild"],
    prompt: `I want to command this Mac from my iPhone with Siri. Set it up so a Shortcut can send you whatever I dictate, and treat that text as an instruction to carry out here — run project commands, organize files, look something up, draft an email, anything. Prefer reversible actions, and if what I said is destructive or ambiguous, don't act: send me a clarifying question instead.

Always send the outcome (or the question) back to my phone via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}. When you're done, give me exact steps to build the "Tell my Mac" Shortcut, including the address it should send to.`,
  },
  {
    id: "voice-capture-triage",
    title: "Voice capture triage",
    description:
      "Dictate a messy thought; it gets classified and filed in the right note.",
    tags: ["iphone", "productivity"],
    prompt: `When I dictate a thought from my iPhone, file it in the right place. A Shortcut will send you the text; classify it — todo, idea, shopping item, journal entry, or reminder — and file it into {{notes setup (e.g. ~/notes with todo.md, ideas.md, shopping.md, journal.md)}}, cleaned up but keeping my meaning.

Confirm with one short line back to my phone via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}, and give me exact steps to set up the Siri "Capture" Shortcut.`,
  },
  {
    id: "voice-expense-logger",
    title: "Voice expense logger",
    description:
      "Say \"lunch, 18 dollars\" and it lands in your ledger with running totals.",
    tags: ["iphone", "personal"],
    prompt: `Let me log expenses by voice from my iPhone — I'll say things like "lunch, 18 dollars". Parse out the amount, what it was for, and a sensible category, and append it with the date to {{ledger file (default: ~/notes/expenses.md)}}, keeping a running total for the month at the top.

Text me back the parsed entry and the month's total via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}} so I catch mistakes, and give me exact steps to set up the Siri "Log expense" Shortcut.`,
  },
  {
    id: "whiteboard-capturer",
    title: "Whiteboard capturer",
    description:
      "Photograph a whiteboard; get structured notes and Mermaid diagrams.",
    tags: ["iphone", "productivity"],
    prompt: `When I photograph a whiteboard with my iPhone, turn it into real notes. A Shortcut will send you the photo; transcribe it faithfully into structured markdown — headings, lists, and any boxes-and-arrows redrawn as Mermaid diagrams — and save the note with the original photo into {{notes folder (default: ~/notes/whiteboards/)}}, named by topic and date.

Send the note's path and a one-line gist back via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}, and give me exact steps for the camera Shortcut.`,
  },
  {
    id: "receipt-snap",
    title: "Receipt snap",
    description:
      "Photograph receipts; vendor, amount, and date flow into your ledger.",
    tags: ["iphone", "personal"],
    prompt: `Let me photograph receipts with my iPhone and have them filed. A Shortcut sends you the photo; read the vendor, total, currency, and date, append a row to {{ledger file (default: ~/notes/expenses.md)}}, and stash the image in {{receipts folder (default: ~/Documents/Receipts)}} renamed like vendor-YYYY-MM-DD.

Reply with what you parsed via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}} so I can catch mistakes, and give me exact steps for the "Snap receipt" Shortcut.`,
  },
  {
    id: "document-scanner-inbox",
    title: "Document scanner inbox",
    description:
      "Photograph any paper; it gets OCRed, named, filed, and summarized.",
    tags: ["iphone", "personal"],
    prompt: `Let me photograph any paperwork with my iPhone and have you deal with it. A Shortcut sends you the photo; read the document, give it a meaningful name, and file it in a fitting category inside {{documents folder (default: ~/Documents/Scanned)}}.

Then reply via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}} with a short summary of what it says — and, importantly, whether it needs anything from me (a deadline, a payment, a signature) and by when. Give me exact steps for the "Scan document" Shortcut when you're done.`,
  },
  {
    id: "business-card-followup",
    title: "Business card follow-up",
    description:
      "Photo of a card becomes a contact note and a drafted follow-up email.",
    tags: ["iphone", "productivity"],
    prompt: `When I photograph a business card at an event, set up the follow-through. A Shortcut sends you the photo; read the card (or a screenshot of a profile), make a contact note in {{contacts folder (default: ~/notes/people/)}} — name, company, role, where we met ({{context, e.g. the event I'm attending this week}}) — look the person and company up briefly, and draft a short follow-up email in my voice inside that note.

Text me the draft via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}, never send the email yourself, and give me the Shortcut setup steps.`,
  },
  {
    id: "food-photo-log",
    title: "Food photo log",
    description:
      "Photograph meals; get a running food journal with rough macros.",
    tags: ["iphone", "personal"],
    prompt: `Keep a food journal from photos I take of my meals. A Shortcut sends you each photo; identify what I'm eating, add an entry to {{meal log (default: ~/notes/meals.md)}} with a rough calorie and macro estimate (clearly marked as an estimate), and text the estimate back via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}.

Once a week, add a short pattern summary to the top of the log — {{what I care about, e.g. protein intake, late-night snacking}}. Give me the "Log meal" Shortcut steps when you're set up.`,
  },
  {
    id: "share-to-knowledge-base",
    title: "Share to knowledge base",
    description:
      "Share any link from your phone; it's deep-read, summarized, and filed.",
    tags: ["iphone", "productivity"],
    prompt: `Anything I share from my iPhone should land in my knowledge base, properly read. A share-sheet Shortcut will send you URLs or text; read the thing for real on this Mac — use my logged-in browser when it's behind a login — and write a note into {{knowledge base folder (default: ~/notes/library/)}} with an actual summary (not the page's own blurb), why it matters to {{my interests and current projects}}, and links to related notes already in the folder.

Text me the one-line takeaway via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}, and give me the share-sheet Shortcut setup steps.`,
  },
  {
    id: "leaving-work-routine",
    title: "Leaving-work routine",
    description:
      "Walking out of the office makes your Mac close out the day for you.",
    tags: ["iphone", "productivity"],
    prompt: `When I leave the office, close out my workday for me. An iPhone location automation will ping you as I leave {{work location}}; then {{end-of-day routine (default: tidy the Desktop into dated folders, safety-commit uncommitted work in my repos to wip branches without touching working trees, and write an end-of-day summary of today's git activity)}}, and text me the summary for the commute via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}. Never push anything anywhere, and if it pings more than once within an hour, only act on the first.

Give me the location-automation setup steps when you're done, including turning on Run Immediately so it fires without confirmation.`,
  },
  {
    id: "arriving-home-briefing",
    title: "Arriving-home briefing",
    description:
      "A \"while you were out\" digest is ready as you walk in the door.",
    tags: ["iphone", "personal"],
    prompt: `When I get home, have a "while you were out" digest waiting. An iPhone location automation pings you as I arrive at {{home location}}; put together the handful of things that matter — {{what to check (e.g. unread email subjects via the browser, CI status of my repos, package tracking updates, tonight's calendar)}} — and send it via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}. Repeated arrivals within an hour only count once.

Give me the automation setup steps when you're done, with Run Immediately turned on.`,
  },
  {
    id: "sleep-focus-night-shift",
    title: "Sleep Focus night shift",
    description:
      "Turning on Sleep Focus puts your Mac to work while you sleep.",
    tags: ["iphone", "wild"],
    prompt: `When I go to sleep, put this Mac to work. An iPhone automation pings you when Sleep Focus turns on; then run the night shift: {{night tasks (e.g. run the full test suites in my active repos and note failures, tidy Desktop and Downloads, pre-generate tomorrow morning's briefing)}}. Work steadily and safely — nothing destructive, nothing pushed or sent anywhere — and one night only counts once, however many times the automation fires.

Leave a report at {{report file (default: ~/Desktop/night-shift.md)}} for the morning; don't message my phone while I sleep. Give me the Sleep Focus automation setup steps when you're done.`,
  },
  {
    id: "nfc-agent-buttons",
    title: "NFC agent buttons",
    description:
      "Stickers around your home become physical buttons for agent routines.",
    tags: ["iphone", "wild"],
    prompt: `Turn NFC stickers into physical buttons for routines on this Mac. Each sticker's iPhone automation will send you a tag name; run the matching routine: {{tags and routines (e.g. "desk" starts a work-session log with my current git context; "door" runs my leaving routine; "gym-bag" sends today's training plan to my phone)}}. Unknown tags just get logged to ~/notes/nfc-log.md.

When a routine produces something for me, send it via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}. Give me setup steps for one automation per sticker, with Run Immediately turned on.`,
  },
  {
    id: "workout-ended-coach",
    title: "Workout coach",
    description:
      "Every finished workout is logged against your plan, which adapts.",
    tags: ["iphone", "personal"],
    prompt: `Be my training log and coach. An iPhone automation will ping you when a workout ends, with the type, duration, and calories; log it in {{training log (default: ~/notes/training.md)}} against {{my training plan (file path, or describe it: goals, weekly split)}}, and adjust what tomorrow should be based on what I actually did — missed sessions, extra volume, rest needs.

Reply with a short acknowledgment plus tomorrow's session via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}} — {{coaching tone (e.g. encouraging but honest)}} — and give me the workout automation setup steps.`,
  },
  {
    id: "morning-alarm-briefing",
    title: "Morning alarm briefing",
    description:
      "Dismissing your alarm generates the day's briefing before you're up.",
    tags: ["iphone", "productivity"],
    prompt: `The moment I stop my morning alarm, have my briefing on its way. An iPhone automation pings you when the alarm is dismissed; build today's briefing fresh — {{briefing contents (e.g. today's calendar, weather, the top items from ~/notes/todo.md, anything urgent in email subjects)}} — five scannable lines, not five paragraphs, and send it via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}} so it's waiting before I'm out of bed. Snoozing should only produce one briefing.

Give me the alarm automation setup steps when you're done.`,
  },
  {
    id: "carplay-audio-briefing",
    title: "CarPlay audio briefing",
    description:
      "Connecting to CarPlay drops a listenable commute briefing into iCloud.",
    tags: ["iphone", "personal"],
    prompt: `When my iPhone connects to CarPlay, prepare an audio briefing I can play in the car. The automation pings you on connect; write a spoken-style commute update — {{briefing contents (e.g. first meeting and when to leave, today's priorities, one interesting update from my monitoring reports)}} — synthesize it to audio with the say command, and drop it into {{iCloud folder (default: ~/Library/Mobile Documents/com~apple~CloudDocs/Briefings/)}} named by date so it shows up in the Files app in the car.

Also send the text version via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}, count reconnects within an hour only once, and give me the CarPlay automation setup steps.`,
  },
  {
    id: "morning-briefing",
    title: "Morning briefing",
    description:
      "Calendar, weather, tasks, and urgent email in one digest at your desk.",
    tags: ["productivity"],
    prompt: `Prepare my morning briefing every day at {{time (default: 07:30)}}. Work out of {{context folder (default: ~/notes)}} — my notes and context live there. Pull together today's calendar, the weather for {{my city}}, the top items from my todo file, and, if I keep email in the browser, any urgent-looking subjects.

Write it to briefing.md in that folder, replacing yesterday's — scannable in under a minute. Use the context you find there to judge what "urgent" and "top" actually mean for me.`,
  },
  {
    id: "end-of-day-journal",
    title: "End-of-day journal",
    description:
      "Your day reconstructed from git and file activity into a journal entry.",
    tags: ["productivity"],
    prompt: `Write my work journal for me every weekday at {{time (default: 18:00)}}. Work out of {{context folder (default: ~/notes)}}. Reconstruct what I actually did today from evidence — git activity across the repos under {{code directory (default: ~/code)}}, files that changed in my notes, and how the day compares to what the morning briefing planned.

Write a dated entry into journal/ there: what got done, what moved but didn't finish, what looks blocked. Honest and specific, no filler — these entries feed my standups and reviews.`,
  },
  {
    id: "follow-up-nagger",
    title: "Follow-up nagger",
    description:
      "Things you're waiting on get polite follow-up drafts before they rot.",
    tags: ["productivity"],
    prompt: `Track what I'm waiting on from other people. Every day at {{time (default: 09:00)}}, read waiting-on.md in {{context folder (default: ~/notes)}} — each item says who owes me what and since when. For anything older than {{days before nagging (default: 4)}}, draft a polite, short follow-up in my voice beneath the item, escalating gently on repeat nags.

Flag anything that's been waiting absurdly long at the top of the file. Never send anything — the drafts are for me to paste.`,
  },
  {
    id: "meeting-prep-assistant",
    title: "Meeting prep assistant",
    description:
      "Every meeting today gets a prep note: people, history, open items.",
    tags: ["productivity"],
    prompt: `Prep me for my meetings every weekday at {{time (default: 08:00)}}. Work out of {{context folder (default: ~/notes)}}. Check today's calendar, and for each meeting with other attendees write a prep note into meetings/ there: what my notes already say about these people and this topic, open action items from last time, and questions worth asking.

If the context is thin, say so instead of padding. Keep each note under a page.`,
  },
  {
    id: "decisions-ledger",
    title: "Decisions ledger",
    description:
      "Meeting recordings distilled to just the decisions and commitments.",
    tags: ["productivity"],
    prompt: `Keep a ledger of decisions from my meeting recordings. Watch {{recordings folder (e.g. where my meeting app saves audio)}} for new recordings, and handle each one exactly once: transcribe it, then pull out just the decisions and commitments — who agreed to what, by when, and any alternatives that were explicitly rejected and why.

Append them to decisions.md in {{context folder (default: ~/notes)}} under the meeting's date and topic. Ignore chit-chat and status updates completely; if a meeting produced no decisions, record nothing.`,
  },
  {
    id: "relationship-keeper",
    title: "Relationship keeper",
    description:
      "Friends you've gone quiet on get remembered, with check-in drafts.",
    tags: ["personal"],
    prompt: `Help me stay in touch with people I care about. Every week at {{time (default: Sunday 17:00)}}, read the people/ notes in {{context folder (default: ~/notes)}} — one note per person with birthdays, last contact, and what's going on in their life. Write me a weekly note: who I've gone quiet on, whose birthday is coming, who mentioned something worth following up on (an interview, a move, a health thing).

For each, draft a short check-in message in my voice that references what they last shared. Never send anything, and keep each person's note updated as I log new contact.`,
  },
  {
    id: "pantry-meal-planner",
    title: "Pantry & meal planner",
    description:
      "Weekly meals planned from what you actually have, expiring items first.",
    tags: ["personal"],
    prompt: `Plan my meals from what I actually have. Every week at {{time (default: Saturday 10:00)}}, work out of {{context folder (default: ~/notes)}}: read pantry.md (what I have, with dates where known) and meals.md if it exists (what I've actually been eating). Plan the week honoring {{dietary preferences and constraints}}, using up whatever expires soonest.

Write the plan to meal-plan.md with a shopping list of only what's missing, and update pantry.md for what the plan will consume so it stays truthful.`,
  },
  {
    id: "subscription-auditor",
    title: "Subscription auditor",
    description:
      "Recurring charges get found, compared month over month, and challenged.",
    tags: ["personal"],
    prompt: `Audit my subscriptions once a month at {{time (default: the 1st at 10:00)}}. Work out of {{context folder (default: ~/notes)}}: read my expense ledger (expenses.md) and {{other sources (optional: a statements folder of bank or card PDFs)}} to find the recurring charges. Compare month over month — flag price hikes, duplicate services, and anything that looks unused given what my notes say about my life.

Write the audit to subscriptions.md with my total monthly burn, and draft cancellation or downgrade emails for the flagged ones. Never send or cancel anything yourself.`,
  },
  {
    id: "home-assistant-bridge",
    title: "Home Assistant bridge",
    description:
      "Smart home events get an agent's judgment, not just an automation.",
    tags: ["personal", "wild"],
    prompt: `Connect my smart home to this Mac. Home Assistant will send you events — doorbell, sensors, whatever I automate — and I want your judgment applied to each one: {{house rules (e.g. doorbell while I'm away: fetch the camera snapshot from Home Assistant and describe who or what is there; leak or smoke sensor: alert me immediately; front door open with nobody home: flag it)}}.

You can query and control devices through the Home Assistant API at {{Home Assistant URL (e.g. http://homeassistant.local:8123)}} — the access token is in {{token file (e.g. ~/.secrets/hass-token)}}; never print it. Log events to home-log.md in {{context folder (default: ~/notes)}}, send anything urgent via {{reply channel (e.g. iMessage to my own number, or ntfy.sh/my-topic)}}, and when you're set up, give me an example Home Assistant automation that sends you an event.`,
  },
];
