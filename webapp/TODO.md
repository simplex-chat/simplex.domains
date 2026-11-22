# Names page: screen issues to fix after #19 and #8243 merge

Language audit, first: once #8243 is merged, every text the page, the service and the guide show to people is catalogued, and every text outside the happy path is rewritten, everywhere it appears. The rules below and the items in the table are inputs to that audit, not its scope; the table lists the screens reviewed up to checkout-select-selected-elsewhere.

All texts: abstract concepts never act. Every text of the page, the service's messages and the guide is screened for codes, names, payments, orders, balances, terms or registries acting (register, cover, refuse, decide, try, judge), and each one is reworded, beyond the screens listed below. Physical objects and machines may take verbs of their function.

All texts of #19: the texts are unnecessarily detailed, aim at precision instead of helping people understand, and give abstract concepts actions. Each text is shortened to what helps the person act.

All texts, compliance: a name code has no monetary value, and nothing may say or imply that it pays, is a payment, or pays for anything. Names given to investors are a free perk, and a code is only the means by which an investor registers that free name; anything of monetary value given to investors would form part of the investment contract. The page's language equates codes with money throughout. A person uses a code to register a name. This covers the page's texts ("it pays", "a code pays"), the service's messages, the guide, the docs and plans, and the service's public answer, which names a code under `payment` (`payment: {type: "code"}`).

All texts: tense and person. A text addresses the person reading it as "you", never as a third party ("its owner"), and states what happens after an action in the future tense, not the present.

| # | Screen | Issue |
|---|---|---|
| 1 | checkout-code-no-storage | Show the public address the name is stored at, and recommend checking on Etherscan that the name landed there. The link opens the page where the person sees the name owned by their address. The private key alone is not enough. |
| 2 | checkout-community-accepted | The community terms shown make no sense. In the screenshots they are the contracts repository's test fixtures (test/fixtures/terms/community-terms.md and general-terms.md), which dev/deploy.ts publishes; the deployed page shows the terms linked on chain. Make the screenshots show the real terms texts, and rewrite the community terms page where its own text is wrong. |
| 3 | checkout-community-unreadable | The screen says the terms cannot be shown; find why it reaches that state, and change what the person sees. |
| 4 | checkout-links-scan-dialog (phone), checkout-review-code-scan-dialog (phone) | The screenshots show no QR code; find whether the scan dialogs are broken or only the screenshots. |
| 7 | checkout-review-bonus-tip (phone) | The tooltip is black in the light theme; restyle it to suit the light theme. |
| 8 | checkout-review-code-verdict-expired | The text says the code registers a name; only a person registers a name. Reword without giving the code an action. |
| 9 | checkout-review-code-verdict-name-code | The message is confusing and the behaviour is wrong. Tell the person it is a name code, show whether it has links, and offer to add it to "Your names" on this page. |
| 10 | checkout-review-code-verdict-not-covering | The text says the code does not "cover" the name; a code covers nothing. Reword in terms of what the person can register with it. |
| 11 | checkout-review-code-verdict-not-issued | The text is insulting; replace it with "contact support". |
| 12 | checkout-review-code-verdict-rate-limited | Checked: the purple square is the screenshot test's mask over the countdown's seconds ("Checking again in 30 seconds"), not the page. No page change. |
| 13 | checkout-review-code-verdict-reserved | The text is insulting, and it says the code registers something; only a person registers a name. Reword. |
| 14 | checkout-review-code-verdict-revoked | The text is wrong and offensive; reword. |
| 15 | checkout-review-code-verdict-unfinished | The message is wrong; reword. |
| 16 | checkout-review-code-verdict-used | The text says the code registered a name; only a person registers a name. Reword. |
| 17 | checkout-review-codes-only-refused (phone) | The language must be polite: "Please enter …". |
| 18 | checkout-review-community-popup | Revise the community name popup: the fixed text in src/views/terms.ts `showCommunity` ("Its owner agrees to use it to benefit this community, not as the brand of one person or business.") and the community's description from the service ("This name is for …"). |
| 20 | order-registering-wait (found by the screenshot test) | A countdown of 10:00 or more overflows its box: `.countdown b` has `min-width: 4ch` (styles.css), and "10:00" is 5 characters, so its last digit draws outside the box. |
| 21 | order-pay-crypto-cancel-limited, order-pay-crypto-cancel-refused (phone) | At 390 px the notice covers "Cancel this invoice": the step's fixed height lets its content overflow into the actions row (found in the baselines). |
| 22 | checkout-review-waiting-card (phone) | The text is long and confusing; shorten it. |
| 23 | checkout-status-codes-only | The text is confusing; reword. |
| 24 | checkout-status-failed | The texts are bad; rewrite them. |
| 25 | checkout-status-price-changed | The text is bad and disrespectful; rewrite it. |
| 26 | checkout-status-taken, checkout-status-too-many-ended, checkout-select-refused-taken | "Nothing was charged" and "nothing more is charged" are bad texts; reword them everywhere they appear. |
| 27 | checkout-status-too-many (desktop and phone), checkout-select-held | A pink square shows. The screen answers 429 with a 30-second wait, which the page counts down ("Try again in …"), so it is probably the screenshot test's mask over the seconds, as in item 12; to confirm. |
| 28 | checkout-status-unavailable | Issue to be stated by the user. |
| 32 | home-codes-only-uncovered | The warning is bad; rewrite it. |
| 33 | home-community-popup-for (and item 18) | The popup speaks of "its owner" where it means the reader, and uses the present tense for what the reader will agree to on registering. Address the reader as "you", in the future tense. |
| 34 | home-other-order-registering, and all public surfaces | No screen, service answer, mock or guide text shows that a name is being registered or held for another buyer; review each of them. |
| 35 | home-phone-menu (phone) | The phone menu needs to change; what to change is to be stated by the user. |
| 36 | home-reserved | Bad language: "yours to use" is borderline insulting; reword. |
| 39 | screenshot test | The countdown masks show as pink squares, which read as page defects in review (items 12, 27, checkout-select-selected-elsewhere on the phone, home-select-selected-elsewhere, order-registering-committing on the phone). Show countdowns at a fixed value from the test clock instead of masking them, or draw the mask in the background colour (Playwright's `maskColor`). |
| 40 | checkout-select-selected-elsewhere | Resolved by #19: the page opens the order whose name was selected elsewhere, and "Your order went …" is gone. |
| 41 | order-unreadable (phone) | "The page keeps trying …" gives the page an effort; reword. The screen asks to "quote the reference below", and the reference shown reads "unreadable": show the order's reference, or do not ask to quote one. |
| 43 | service and page: fees | When the fee needed is above `max_fee_per_gas`, the service already sends nothing and tries again every 15 s (Sender `SEFeeAboveCap`), but counts it as an operator failure, reported to the group after 10 minutes. Treat a fee spike as a wait: postpone sending until the fee falls, report to operators only after a long wait, and show the buyer that the registration waits for lower network fees. |
| 44 | service and page: paused orders | A refusal that means the page and the service are configured differently (the "permanent" revert reasons, such as InvalidSignature, NameTooShort and LabelTooLong), and the sent-failure cap, pause the order instead of failing it: no more attempts or gas until operator intervention, which resumes or fails it. The buyer sees the name as being registered, with attempts paused. |
| 45 | order-registering-lapsed | While a lapsed order is committed again, the page shows "The name was not signed in time". Decide in the language audit; proposed: show the same screen as the first commit, without that line, since the person has nothing to do. |
| 46 | home search of a name this browser's own paid order holds | Show the row as names drew it, with the order's price and years, and a "Your order" button that opens the order in place of Register. Decide in the language audit between A, with no line under the row, and B, with "You already paid for this name, the order is being processed." (for a paid order only). |
| 47 | home-own-order-failed, and every home search of a name this browser has an order for | Show a "Your order" button that opens the order, as decided for screen 16 (item 46), in place of the footer. The user asked for it on 19 November; it was applied nowhere. |
| 48 | home-select-failed-order (phone) | The order reference appears twice on the page; show it once. |
| 52 | names-edit-config-unread | Bad language: "The name could not be read now" and "This page tries again by itself" (the page acting). Rewrite. |
| 53 | order-closed-paid-late-support (phone), order-closed-received-support (phone), order-failed-action-failed (very long on the phone), order-failed-month-code (phone), order-failed-unread-code (very long on the phone) | The text is long; shorten it. |
| 55 | checkout-select-refused-price (phone) | The texts are not understood. A name of another price than a paid order's is offered as any name: Check your order shows its price ("Total $100") and "Register with your payment", and the service refuses the selection with `catalog_changed`, which the page shows as a new order's refusal: "The price changed", "… costs $100 now; it changed while you were deciding. Nothing was charged." The price did not change, and the person paid earlier; the screen says neither why the name is refused nor what the person can do (another name at the price paid, or support, who handle price differences). Rewrite in the language audit. |
| 56 | checkout-review-code-verdict-unpaid, checkout-review-code-refused-unpaid, names-check-prepaid-unpaid, names-code-unpaid | A code in the service's `unpaid` state reads "This code is not paid for yet", "It works once its payment is confirmed." and, in Your names, "Not paid yet": a payment for the code, which the compliance rule above excludes. Say what the state means without money words; language audit. |
