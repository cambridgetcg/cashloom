# CashLoom: contrast

WCAG 2.x ratio is the conformance bar (AA: 4.5 text, 3 large text and UI). APCA Lc is shown as guidance from the WCAG 3 drafts.

| mode | foreground | on | colours | ratio | needs | APCA Lc | |
|---|---|---|---|---|---|---|---|
| light | `text` | `bg` | #181F1B on #F7F8F2 | 15.72 | 4.5 | 99.2 | ✓ |
| light | `text-muted` | `bg` | #57685E on #F7F8F2 | 5.54 | 4.5 | 75.1 | ✓ |
| light | `text` | `surface` | #181F1B on #E1E4E2 | 13.11 | 4.5 | 87.4 | ✓ |
| light | `focus` | `bg` | #255B46 on #F7F8F2 | 7.38 | 3 | 82.6 | ✓ |
| light | `primary-text` | `bg` | #255B46 on #F7F8F2 | 7.38 | 4.5 | 82.6 | ✓ |
| light | `accent-text` | `bg` | #465E2A on #F7F8F2 | 6.79 | 4.5 | 80.6 | ✓ |
| light | `on-primary` | `primary` | #FFFFFF on #255B46 | 7.88 | 4.5 | -91.9 | ✓ |
| light | `on-accent` | `accent` | #000000 on #648045 | 4.72 | 4.5 | 33.2 | ✓ |
| light | `primary-ui` | `bg` | #255B46 on #F7F8F2 | 7.38 | 3 | 82.6 | ✓ |
| light | `accent-ui` | `bg` | #648045 on #F7F8F2 | 4.17 | 3 | 66.3 | ✓ |
| light | `primary` | `bg` | #255B46 on #F7F8F2 | 7.38 | 0 | 82.6 | info |
| light | `accent` | `bg` | #648045 on #F7F8F2 | 4.17 | 0 | 66.3 | info |
| dark | `text` | `bg` | #F5F7F6 on #183A30 | 11.57 | 4.5 | -96.0 | ✓ |
| dark | `text-muted` | `bg` | #96A69C on #183A30 | 4.88 | 4.5 | -45.7 | ✓ |
| dark | `text` | `surface` | #F5F7F6 on #2D4F45 | 8.43 | 4.5 | -89.6 | ✓ |
| dark | `focus` | `bg` | #5E937C on #183A30 | 3.52 | 3 | -32.6 | ✓ |
| dark | `primary-text` | `bg` | #7DAE98 on #183A30 | 4.97 | 4.5 | -46.6 | ✓ |
| dark | `accent-text` | `bg` | #91AC76 on #183A30 | 4.96 | 4.5 | -46.5 | ✓ |
| dark | `on-primary` | `primary` | #181F1B on #5E937C | 4.75 | 4.5 | 38.9 | ✓ |
| dark | `on-accent` | `accent` | #000000 on #648045 | 4.72 | 4.5 | 33.2 | ✓ |
| dark | `primary-ui` | `bg` | #5E937C on #183A30 | 3.52 | 3 | -32.6 | ✓ |
| dark | `accent-ui` | `bg` | #749155 on #183A30 | 3.51 | 3 | -32.4 | ✓ |
| dark | `primary` | `bg` | #5E937C on #183A30 | 3.52 | 0 | -32.6 | info |
| dark | `accent` | `bg` | #648045 on #183A30 | 2.8 | 0 | -24.6 | info |

Note: dark mode --primary is #5E937C (primary 500, 3.52:1 on the dark ground), not the brand colour #255B46, which is 1.58:1 there and would disappear as a fill.
