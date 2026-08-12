// Contract tests for the account-name classifier.
//
// Account NUMBERS collide across the 80+ consolidated entities, so grouping is
// driven by the account NAME. Name matching is substring-based, which is what
// silently put "6165 Employee Laboratory or Medical Visit Expense" into IT
// Expense: it contains "it expense" ("...medical visIT EXPENSE"). These cases
// pin the boundaries that bug crossed, plus one row per KPI group.

import { classify } from "../lib/classify.ts";

const CASES: Array<[string, string | null]> = [
  // the regression: substring "it expense" inside another word must NOT hit IT
  ["6165 Employee Laboratory or Medical Visit Expense", "General Business Expenses"],
  ["6280 IT Expense", "IT Expense"],
  ["6285 IT Expenses", "IT Expense"],
  ["6290 Software Subscriptions", "IT Expense"],

  // "supplies" is tested before the general bucket, so this stays Other
  ["6145 Medical Supplies", "Other Business Expenses"],

  // one per group, to catch ordering regressions
  ["5010 Food and Beverage", "Cost of Goods Sold"],
  ["6010 PPC- Pay Per Click", "Advertising & Marketing"],
  ["6020 Website/SEO", "Advertising & Marketing"],
  ["6080 Contract Labor", "Contract Labor"],
  ["6160 Hiring and Recruiting", "General Business Expenses"],
  ["6140 Office Expenses and Other Supplies", "Other Business Expenses"],
  ["7050 Salaries and Wages", "Payroll Expenses"],
  ["7020 Employee Health Insurance", "Payroll Expenses"],

  // income / contra legs are excluded entirely (never summed, never double-counted)
  ["7040 Income from Capital One", null],
  ["6600 Credit Card Rewards", null],
  ["4000 Patient Revenue", null],
];

let bad = 0;
for (const [label, want] of CASES) {
  const got = classify(label).group;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}\n        want=${want ?? "(excluded)"}  got=${got ?? "(excluded)"}`);
}
console.log(`\n${CASES.length - bad}/${CASES.length} passed`);
if (bad) {
  console.error(`${bad} classification case(s) failed`);
  process.exit(1);
}
