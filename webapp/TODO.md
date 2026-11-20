# Names page: screen issues to fix after #19 and #8243 merge

Language audit, first: once #8243 is merged, every text the page, the service and the guide show to people is catalogued, and every text outside the happy path is rewritten, everywhere it appears. The rules below and the items in the table are inputs to that audit, not its scope; the table lists the screens reviewed up to home-retarget-moved-after-refusal.

All texts: abstract concepts never act. Every text of the page, the service's messages and the guide is screened for codes, names, payments, orders, balances, terms or registries acting (register, cover, refuse, decide, try, judge), and each one is reworded, beyond the screens listed below. Physical objects and machines may take verbs of their function.

All texts of #19: the texts are unnecessarily detailed, aim at precision instead of helping people understand, and give abstract concepts actions. Each text is shortened to what helps the person act.

All texts, compliance: a name code has no monetary value, and nothing may say or imply that it pays, is a payment, or pays for anything. Names given to investors are a free perk, and a code is only the means by which an investor registers that free name; anything of monetary value given to investors would form part of the investment contract. The page's language equates codes with money throughout. A person uses a code to register a name. This covers the page's texts ("it pays", "a code pays"; for example home-retarget-code-opening), the service's messages, the guide, the docs and plans, and the service's public answer, which names a code under `payment` (`payment: {type: "code"}`).

All texts: tense and person. A text addresses the person reading it as "you", never as a third party ("its owner"), and states what happens after an action in the future tense, not the present.

| # | Screen | Issue |
|---|---|---|
| 1 | checkout-code-no-storage | Show the public address the name is stored at, and recommend checking on Etherscan that the name landed there. The link opens the page where the person sees the name owned by their address. The private key alone is not enough. |
| 2 | checkout-community-accepted, home-retarget-community-terms-popup | The community terms shown make no sense. In the screenshots they are the contracts repository's test fixtures (test/fixtures/terms/community-terms.md and general-terms.md), which dev/deploy.ts publishes; the deployed page shows the terms linked on chain. Make the screenshots show the real terms texts, and rewrite the community terms page where its own text is wrong. |
| 3 | checkout-community-unreadable | The screen says the terms cannot be shown; find why it reaches that state, and change what the person sees. |
| 4 | checkout-links-scan-dialog (phone), checkout-review-code-scan-dialog (phone) | The screenshots show no QR code; find whether the scan dialogs are broken or only the screenshots. |
| 5 | checkout-review-balance-changed | The design is busy and confusing; a buyer landing on it would not pay. Redesign it in names first, then the same screen on the badges pages. |
| 6 | checkout-review-balance-part-coin-only | Waive any difference below $1 when a balance pays the rest, in the service and the page, so nothing is paid for it. This removes the coin-only case (card refused below Stripe's $0.50 least charge: `methodsFor` in src/screens/checkout.ts, and the service's refusal). |
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
| 19 | checkout-review-hold | The layout around the button looks broken. |
| 20 | order-registering-wait (found by the screenshot test) | A countdown of 10:00 or more overflows its box: `.countdown b` has `min-width: 4ch` (styles.css), and "10:00" is 5 characters, so its last digit draws outside the box. |
| 21 | order-pay-crypto-cancel-limited, order-pay-crypto-cancel-refused (phone) | At 390 px the notice covers "Cancel this invoice": the step's fixed height lets its content overflow into the actions row (found in the baselines). |
| 22 | checkout-review-waiting-card (phone) | The text is long and confusing; shorten it. |
| 23 | checkout-status-codes-only | The text is confusing; reword. |
| 24 | checkout-status-failed | The texts are bad; rewrite them. |
| 25 | checkout-status-price-changed | The text is bad and disrespectful; rewrite it. |
| 26 | checkout-status-taken, checkout-status-too-many-ended, home-retarget-community | "Nothing was charged" and "nothing more is charged" are bad texts; reword them everywhere they appear. |
| 27 | checkout-status-too-many (desktop and phone), home-retarget-held | A pink square shows. The screen answers 429 with a 30-second wait, which the page counts down ("Try again in …"), so it is probably the screenshot test's mask over the seconds, as in item 12; to confirm. |
| 28 | checkout-status-unavailable | Issue to be stated by the user. |
| 29 | home-available-balance-held-funded | Confusing: the search result says the balance is in use; if it is in use, the search result need not mention it. |
| 30 | home-available-balance-rest | The search result says how much is left to pay; it need not say it there. |
| 31 | home-available-balance-short | "Your balance covers …" gives the balance an action; reword. |
| 32 | home-codes-only-uncovered | The warning is bad; rewrite it. |
| 33 | home-community-popup-for (and item 18) | The popup speaks of "its owner" where it means the reader, and uses the present tense for what the reader will agree to on registering. Address the reader as "you", in the future tense. |
| 34 | home-other-order-registering, and all public surfaces | No screen, service answer, mock or guide text shows that a name is being registered or held for another buyer; review each of them. |
| 35 | home-phone-menu (phone) | The phone menu needs to change; what to change is to be stated by the user. |
| 36 | home-reserved | Bad language: "yours to use" is borderline insulting; reword. |
| 37 | home-retarget-code-no-text-shorter | The footer text is bad: "if it covers a name that long" gives the code an action; rewrite. |
| 38 | home-retarget-code-opening-no-text (phone) | The text is weird, and says "34 or more". 34 is the length of the test's name (the state id), whose code order failed with `NameTooShort`. Check where the page takes that number; a code's minimum length comes from the code, not the failed name. |
| 39 | screenshot test | The countdown masks show as pink squares, which read as page defects in review (items 12, 27). Show countdowns at a fixed value from the test clock instead of masking them, or draw the mask in the background colour (Playwright's `maskColor`). |
| 40 | home-retarget-moved-after-refusal | Resolved by #19: the page opens the moved order, and "Your order went …" is gone. |
| 41 | order-unreadable (phone) | "The page keeps trying …" gives the page an effort; reword. The screen asks to "quote the reference below", and the reference shown reads "unreadable": show the order's reference, or do not ask to quote one. |
| 42 | checkout-review-balance-gone (phone) | Bad language; rewrite. |
| 43 | service and page: fees | When the fee needed is above `max_fee_per_gas`, the service already sends nothing and tries again every 15 s (Sender `SEFeeAboveCap`), but counts it as an operator failure, reported to the group after 10 minutes. Treat a fee spike as a wait: postpone sending until the fee falls, report to operators only after a long wait, and show the buyer that the registration waits for lower network fees. |
| 44 | service and page: paused orders | A refusal that means the page and the service are configured differently (the "permanent" revert reasons, such as InvalidSignature, NameTooShort and LabelTooLong), and the sent-failure cap, pause the order instead of failing it: no more attempts or gas until operator intervention, which resumes or fails it. The buyer sees the name as being registered, with attempts paused. |
| 45 | order-registering-lapsed | While a lapsed order is committed again, the page shows "The name was not signed in time". Decide in the language audit; proposed: show the same screen as the first commit, without that line, since the person has nothing to do. |
| 46 | home search of a name this browser's own paid order holds | Show the row as names drew it, with the order's price and years, and a "Your order" button that opens the order in place of Register. Decide in the language audit between A, with no line under the row, and B, with "You already paid for this name, the order is being processed." (for a paid order only). |
| 47 | home-own-order-failed, and every home search of a name this browser has an order for | Show a "Your order" button that opens the order, as decided for screen 16 (item 46), in place of the footer. The user asked for it on 19 November; it was applied nowhere. |
