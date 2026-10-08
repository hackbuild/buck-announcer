# Rules for working in this repository

These rules are absolute. They apply to every file, every commit, and every generated string, including code comments, log lines, and the status page. Where any other document disagrees with this one, this one wins.

## Attribution

- Never add Claude, any AI assistant, or any AI tool as an author, co-author, contributor, or credit of any kind. Not in commit messages, not in Co-Authored-By trailers, not in comments, not in documentation.
- Commit messages carry no trailers, no badges, no generated-with lines. Subject in the imperative, lowercase, under 60 characters. Body only when the change needs explaining, wrapped at 72 columns.
- Author is Moheeb Zara <hackbuildvideo@gmail.com>.

## Language

- No emojis, anywhere.
- No em dashes or en dashes. Use commas, periods, or the word "to" for ranges.
- No "it is not x, it is y" construction or its variants.
- No closing line that restates the point.
- No exclamation marks in prose, logs, or UI copy.
- No marketing adjectives: seamless, powerful, robust, comprehensive, beautiful, elegant, and their kin. Say what it does.
- No filler openers: "Let's", "Simply", "Just", "Note that".
- Log lines and UI copy are lowercase and terse, and name the failure: "no WiFi set, send: /wifi <ssid> <password>" beats "error".
- Never claim a capability the hardware does not have.

## This service

- Secrets never go in the repo: the Cloudflare API token lives in the deployer's environment, never in `wrangler.toml` or a file.
- The web side stays read only. Nothing reachable over HTTP makes BUCK speak.
- The five minute announce run stays cheap: no ICS parsing unless the cache is missing, and only after it has spoken.
- `npm test` and `npm run typecheck` pass before a commit.
