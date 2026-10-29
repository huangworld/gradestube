# GradesTube

A Chrome extension for grading YouTube video assignments against a rubric. It reads a video's transcript, has an LLM score each rubric item, and backs every score with verbatim, timestamped quotes you can click to jump into the video. You can override any score, tag evidence by hand, and export a whole homework's grades in one go.

Works with Anthropic (Claude), OpenAI, and Gemini, or fully manual grading with no API key.

## Features

- **Homeworks.** Each homework has one rubric, reused for every video in it until you replace or remove it.
- **In-page button.** Open a video's transcript on YouTube and a **Grade based on rubric** bar appears at the top of the panel. No need to click the extension icon.
- **Side panel grading.** Every rubric item gets a score, a rationale, and quotes with timestamps. Click a timestamp to seek the video.
- **Grounding checks.** Each quote the model cites is matched against the real transcript. Quotes that can't be found are flagged **⚠ unverified**, close matches get **≈**.
- **Overrides.** Change any item score or the overall total. Your overrides are shown in purple, kept separate from the AI score, and can be reset with ↺.
- **Manual mode.** Select any text in the transcript, even across several lines, and tag it to one or more rubric items. The rubric view updates right away.
- **Model switching.** Pick provider and model in the panel or dashboard. Model lists load live from each provider. Star favorites for one-click switching. Re-grade with another model and toggle **compare** to see where models disagree.
- **Batch mode.** Paste a list of `student, url` lines and grade them all from the dashboard.
- **Exports.** CSV for the gradebook, a Markdown report with quotes and timestamp links, full JSON, and a zip of all transcripts.

## Install

1. Clone this repo.
2. Go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the repo folder.
4. Pin the extension if you like. Clicking its icon copies the open transcript to your clipboard.

After you update the code, click reload on `chrome://extensions`, then refresh any open YouTube tabs.

## Workflow

### 1. Set up a homework (once per assignment)

Open the side panel (click the extension icon, or **Grade** on any transcript). With no homework yet, the panel shows a **New homework** form right away:

1. Type a name, for example "A3 Video Pitch".
2. Drop in a rubric (`.md`, `.txt`, `.csv`, `.tsv` or `.xlsx`), or paste anything, even loose prose, then click **Create**. See [`examples/sample-rubric.md`](examples/sample-rubric.md).
3. Pick **Edit rubric…** from the homework menu at the top to fix titles or points. The full rubric text is also sent to the model, so details in it still count.

The homework menu at the top of the side panel and dashboard switches homeworks and creates new ones. The most recently used homework is selected automatically.

API keys and models live behind **☰** (top right). Paste a key for each provider you want. Skip this for manual-only grading. Star models you'll switch between: they show up in the quick model menu next to **Grade**.

How parsing works:

- With an API key set, the selected model turns the rubric into items: one per separately scored thing, sub-parts named "Parent · Sub-part", full/partial/zero credit text kept in the description, fractional points kept as-is (0.125 works). Grading rules that apply across items go into **Grading notes** and are sent with every video.
- Without a key, a built-in parser handles headings, bullets and markdown tables with points:

```markdown
## Solution demo (20 pts)            <- headings with points
- Delivery: clear and paced [5]      <- bullets with points
| Criterion | Description | Points | <- markdown tables
```

### 2. Grade one video

1. Open the student's video on YouTube.
2. Under the description, click **Show transcript**.
3. In the bar at the top of the transcript panel, click **✦ Grade**.
4. The side panel opens and grades with the selected model. The model name next to **Grade** switches models. If Chrome blocks the panel from opening, right-click the extension icon and choose **Open side panel**.
5. Review each item:
   - Click a **timestamp** to play that moment.
   - Click a **quote** to see it in the transcript tab.
   - Type a new score to override. It turns purple; ↺ goes back to the AI score.
   - Remove weak evidence with ×. Add a note.
6. Override the total next to the big score if needed, add a comment, then set status to **Reviewed**.

Everything autosaves. Reopening the video restores your grades.

### 3. Grade manually or add evidence

1. Pick **Manual** in the model menu next to **Grade**, or open the **Transcript** tab at any time.
2. Select text in the transcript. A popover lists the rubric items.
3. Check one or more items and click **Tag**.
4. Tagged lines get colored markers per item, and the snippet shows up under those items in the **Rubric** tab with a person badge.

### 4. Batch a whole homework

1. Open the **Dashboard** with the table icon at the bottom of the side panel.
2. Paste videos, one per line, then click **Add**:
   ```
   Jane Doe, https://youtu.be/abc123
   Team 7, https://www.youtube.com/watch?v=xyz789
   ```
3. Choose a model (button next to **Grade ungraded**) and click **Grade ungraded**. Each video opens in a muted tab, its transcript is read, and the tab closes.
   - Doc icon: fetch transcripts only, for manual grading.
   - Refresh icon: re-grade all, adding a run from another model. Your overrides are kept.
   - Warning icon: retry failed.
   - If tabs fail with "Transcript did not load", turn on **foreground tabs** in ☰. Chrome can throttle background tabs.
4. Filter by **Review** or **⚠** (unverified quotes), then hover a row and click ↗ to check it in the side panel.

### 5. Export

From the dashboard's share menu (top right of the toolbar):

| Item | Gives you |
|---|---|
| CSV | One row per video: student, per-item scores, total, override flags, model, comment |
| Report (.md) | Every video's scores, rationales, and quotes with timestamp links |
| JSON | Full raw data, including all model runs |
| Transcripts (.zip) | One timestamped `.txt` per video |
| View all transcripts | All transcripts stacked on the page, tagged lines highlighted |

The side panel can also **Copy report** for one video, which is handy for feedback comments.

## How grading works

- The model gets the rubric text, the parsed items, and the transcript with numbered lines like `[12|1:05] text`.
- It returns structured JSON: score, rationale, and evidence quotes with line ranges for each item.
- Scores are clamped to each item's max.
- Each quote is checked against the transcript: exact match near the cited lines first, then anywhere, then a fuzzy word-overlap match. The timestamp always comes from the matched line, not from the model.
- Every grading run is kept. The side panel shows which run is active, and **compare** shows all runs side by side.

Default model is `claude-opus-5-5`. Claude requests use structured outputs and server-side refusal fallback.

## Limitations

- Grading only sees speech. Slides, UI demos, or anything shown but not said aren't in the transcript. The model is told to say so rather than guess.
- Videos need captions, either uploaded or auto-generated.
- Transcript reading depends on YouTube's page structure. If YouTube changes it, update `SEG_SELECTORS` in `content.js`.
- API keys are stored unencrypted in the extension's local storage on your machine.
- Calls go straight from the browser to each provider, so usage is billed to your keys.

## Files

```
manifest.json      MV3 manifest
content.js/.css    transcript reading, in-page toolbar, seek
background.js      toolbar copy, opens side panel
sidepanel.*        per-video grading UI
dashboard.*        homework table, batch, exports
options.*          full-page settings (same panel as ☰)
lib/               storage, rubric parsers (LLM + heuristic), xlsx reader, LLM adapters,
                   grounding, exports, settings sheet, rubric editor, SF-style SVG icons
examples/          sample rubric
```
