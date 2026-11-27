# OBTO agent: Chrome Web Store listing (paste-ready)

Store item id: `egjaomfcjndkpcapekhnccbhaiiipcbi`. Package: `dist/obto-agent-1.0.1.zip` (`npm run pack:extension`).
Every image in this folder is checked against the OBTO brand (Figtree, Tile mark, ground #F5F3EF, violet only
for the dot and primary button). Sources and the scripts that made them are in `source/`.

## Package tab

Upload `obto-agent-1.0.1.zip` (it replaces the 1.0.0 draft: Figtree bundled, OBTO mark in the popup, brand
colours, privacy link to #chrome-extension, popup fix).

## Store listing tab

- **Description** (paste as is):

> OBTO agent lets your OBTO AI agent open, read and, when you allow it, act on web pages in its own tab group in your Chrome, signed in as you, only on sites you approve.
>
> How it works
> 1. Install the OBTO bridge on your computer: npm install -g @obtoai/agent-bridge, then run obto-bridge browser extension install.
> 2. Add this extension and click "I agree, turn it on". Nothing connects before you agree.
> 3. Ask your agent in OBTO to do something on a site, for example "read my Hacker News profile".
> 4. OBTO asks you to approve that site. The agent then works in its own "OBTO agent" tab group.
>
> You stay in control
> - Every site needs your approval in OBTO, for one task or for longer.
> - The agent works only in its own tab group. Your other tabs are not visible to it.
> - It never types passwords, payment details or one-time codes.
> - It never sends, posts, submits, buys, pays or deletes for you. It prepares the step; you press the button.
> - Press Stop in the extension or in OBTO to end its use of your browser at once.
>
> Privacy
> Page text the agent reads goes only to your OBTO conversation and the AI model you chose. It is never sold, never used for ads and never used to train AI models. Details: https://www.obto.co/privacy#chrome-extension
>
> Requirements
> An OBTO account and the OBTO bridge on this computer (macOS or Linux).
>
> Source code: https://github.com/obto-inc/agent-bridge

- **Category:** Productivity → Workflow & planning. **Language:** English.
- **Store icon:** `store-icon-128.png` (96 px artwork, 16 px transparent padding).
- **Screenshots** (1280x800, in this order):
  1. `screenshot-1-reads-your-pages.png`
  2. `screenshot-2-approve-each-site.png`
  3. `screenshot-3-consent-first.png`
  4. `screenshot-4-stop-any-time.png`
  5. `screenshot-5-you-press-send.png`
- **Small promo tile:** `promo-small-440x280.png`. **Marquee:** `promo-marquee-1400x560.png`.
- **Official URL:** obto.co (after Search Console verification). **Homepage:** https://www.obto.co.
  **Support:** https://github.com/obto-inc/agent-bridge/issues.

## Privacy tab

- **Single purpose:** Lets the user's OBTO AI agent open, read and, when the user allows it, act on web pages in
  its own tab group in the user's Chrome, signed in as the user, only on sites the user approves.
- **tabs:** Open and list the agent's own tabs and read their address and title.
- **tabGroups:** Keep the agent's tabs in one labelled "OBTO agent" group so the user sees them and they stay
  separate from the user's tabs.
- **scripting:** Read page text and click or type in the agent's own tabs, using functions packaged in the
  extension.
- **nativeMessaging:** Talk to the OBTO bridge program the user installed on this computer, which carries the
  agent's requests from OBTO.
- **storage:** Remember the user's consent, the On/Off switch and the agent's tab list.
- **Host permission `<all_urls>`:** The agent works on whatever site the user approves for a task. Each site still
  needs the user's approval in OBTO, and the extension refuses sites without it.
- **Remote code:** No, I am not using remote code. Every action is a fixed function in the package; the bridge
  sends only an action name and data.
- **Data usage, tick:** Website content; User activity; Web history (addresses of the agent's tabs only); Personally
  identifiable information and Personal communications (only when present in pages the user asks the agent to
  read). Do not tick Authentication information, Financial and payment information, Health, Location.
- **Certifications:** tick all three.
- **Privacy policy URL:** https://www.obto.co/privacy#chrome-extension

## Distribution tab

Visibility: **Private** (trusted testers) first, per the launch plan. Regions: all.

## Test instructions tab (for the reviewer)

Drafted separately once the reviewer OBTO account exists (plan step 6 F).
