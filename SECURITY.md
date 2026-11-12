# Security policy

## Supported versions

Security fixes are made for the latest released minor version.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/saizul/cwv-watch/security/advisories/new) for this repository
and include:

- a description of the problem and its impact
- steps or a minimal configuration to reproduce it
- the cwv-watch and Node.js versions

You can expect an acknowledgement within a few days. Once a fix is ready it is released and the advisory is published
with credit to the reporter, unless you prefer to stay anonymous.

## Handling of secrets

cwv-watch reads the Google API key, webhook URLs and bot tokens from environment variables and removes them from
error messages, logs and reports. If you find a code path where one of them is written out in clear text, please
report it as a vulnerability.

Good practice when using the tool:

- restrict the API key to the Chrome UX Report API and the PageSpeed Insights API in the Google Cloud console
- store keys and webhook URLs as CI secrets, not in `cwv-watch.config.json`
- treat the HTML and JSON reports as internal if your target URLs are not public
