import AccountModel, { AccountStatusEnum } from "../models/account.model";
import UserModel from "../models/user.model";
import { getRatesToHome, RateQuote, RateSource } from "./fx-rates.service";
import { convertMinor, minorUnitsFor } from "../utils/rate-math";
import { formatMinor } from "../utils/minor-units";
import { InternalServerException } from "../utils/app-error";

// Net-worth valuation: every ACTIVE account's balance expressed in one "home"
// currency, summed without ever touching a float.
//
// PRECISION CORE (why this is correct): accounts are grouped by
// (rail, currency, decimals); each group's balanceMinor strings are BigInt-
// summed FIRST, and each GROUP SUBTOTAL is converted exactly once through
// utils/rate-math convertMinor — ONE half-away-from-zero rounding event per
// group. totalHomeMinor is then the BigInt sum of the converted groups, so the
// displayed components are additive to the total BY CONSTRUCTION (the
// additivity-bound property test in utils/rate-math.test.ts is the executable
// rationale: converting subtotals instead of per-account values bounds any
// drift at one minor unit per group, and summing the converted groups makes
// the drift question moot for the response itself).
//
// minorToMajor (utils/minor-units.ts) is FORBIDDEN here: 18-decimal balances
// above ~0.009 ETH exceed Number.MAX_SAFE_INTEGER and throw there by design.
// Everything stays string/BigInt; formatMinor renders the display strings so
// the client does zero money math.
//
// ZERO WRITES: valuation is derived/display-layer only. Rate output must never
// feed back into Account.balanceMinor — a settable balance is a forgeable
// balance. This service reads accounts and the user's display currency and
// persists nothing.
//
// PARTIAL-TOLERANT: a currency the rate layer cannot price lands in
// unconverted[] with its balance intact and is EXCLUDED from the total — loud
// (complete:false + warnings), never silent, and never a thrown error for one
// bad currency. Only true faults (malformed data, programming errors) escape
// to the errorHandler as 500s.

/* --------------------------------- types --------------------------------- */

// PINNED RESPONSE CONTRACT — P2-6 (client treasury header) builds against this
// verbatim. All money fields are integer minor-unit decimal STRINGS (wei-safe,
// never parseFloat); every *Formatted sibling is rendered server-side with
// utils/minor-units formatMinor so the client renders strings verbatim.

export interface NetWorthGroup {
  rail: string;
  currency: string;
  decimals: number;
  balanceMinor: string; // BigInt sum of the group's account balances
  formatted: string; // formatMinor(balanceMinor, decimals)
  rate: string | null; // decimal string of the applied rate, for auditability
  rateSource: RateSource | null;
  rateAsOf: string | null; // ISO timestamp the SOURCE says the quote is from
  rateStale: boolean;
  homeValueMinor: string | null; // null when the group is unpriced
  homeValueFormatted: string | null;
}

export interface NetWorthByRail {
  rail: string;
  homeValueMinor: string; // BigInt sum of the rail's CONVERTED groups
  homeValueFormatted: string;
  accountCount: number; // every ACTIVE account on the rail
}

export interface UnconvertedEntry {
  currency: string;
  balanceMinor: string;
  decimals: number;
  reason: string; // redacted reason from the rate layer
}

export interface NetWorth {
  home: string;
  homeDecimals: number;
  totalHomeMinor: string;
  totalFormatted: string;
  complete: boolean; // false if anything landed in unconverted[]
  stale: boolean; // true if any applied quote was served stale
  asOf: string; // ISO timestamp of this valuation
  groups: NetWorthGroup[];
  byRail: NetWorthByRail[];
  unconverted: UnconvertedEntry[];
  warnings: string[]; // redacted reasons from the rate layer
  disclaimer: string;
}

/* ------------------------------- constants ------------------------------- */

// FCA-posture requirement: valuation is informational display only — this line
// ships in every response.
const VALUATION_DISCLAIMER =
  "Indicative valuation from public market rates — informational only, not financial advice.";

// Same discipline as utils/minor-units: a balance that is not an integer
// string is corrupt data, never something to coerce.
const INTEGER_STRING_PATTERN = /^-?\d+$/;

/* -------------------------------- internals ------------------------------- */

interface BalanceGroup {
  rail: string;
  currency: string;
  decimals: number;
  subtotal: bigint;
  accountCount: number;
}

const parseBalanceMinor = (balanceMinor: string, accountId: string): bigint => {
  if (
    typeof balanceMinor !== "string" ||
    !INTEGER_STRING_PATTERN.test(balanceMinor)
  ) {
    throw new InternalServerException(
      `Account ${accountId} has a malformed balanceMinor: expected a base-10 integer string`
    );
  }
  return BigInt(balanceMinor);
};

// Pick the redacted rate-layer reason for this group's currency, falling back
// to generic prose — an unpriced group must always say WHY, and never with
// ANOTHER currency's failure text. Raw currency codes are NOT substring-safe
// ("USDC→GBP" contains "USD"), so the match anchors on the exact tokens the
// rate layer embeds: the `${currency}→${home}` pair carried by every
// per-currency reason, then the `"${currency}"` quoted form used by the
// unrecognized-symbol reason. Reasons that name no currency at all (e.g. a
// batched CoinGecko outage) fall through to the generic line by design.
const mentionsPair = (error: string, pair: string): boolean => {
  const index = error.indexOf(pair);
  // A real mention starts the string or follows a non-code character, so a
  // code that is a SUFFIX of another (the way "SD"→ would sit inside "USD"→)
  // can never borrow the longer code's reason either.
  return index === 0 || (index > 0 && !/[A-Z0-9]/.test(error[index - 1]));
};

const reasonFor = (currency: string, home: string, errors: string[]): string =>
  errors.find((error) => mentionsPair(error, `${currency}→${home}`)) ??
  errors.find((error) => error.includes(`"${currency}"`)) ??
  `no ${currency}→${home} rate available`;

/* --------------------------------- service -------------------------------- */

export const netWorthValuationService = async (
  userId: string,
  homeOverride?: string
): Promise<NetWorth> => {
  // Home resolution: explicit override ?? the user's stored display currency
  // (UserModel.currency, default "USD") ?? "USD"; always uppercased.
  let home = homeOverride?.trim();
  if (!home) {
    const user = await UserModel.findById(userId);
    home = user?.currency?.trim();
  }
  home = (home || "USD").toUpperCase();
  const homeDecimals = minorUnitsFor(home);

  // Owner-scoped, ARCHIVED EXCLUDED (mirrors syncAllAccountsService). Product
  // choice: the accounts page still renders archived accounts at 60% opacity,
  // but they do not count toward net worth — the client header carries an
  // explicit "archived excluded" note so the discrepancy stays honest.
  const accounts = await AccountModel.find({
    userId,
    status: AccountStatusEnum.ACTIVE,
  });

  // Group by (rail, currency, decimals) and BigInt-sum each group FIRST —
  // see the precision-core note above.
  const groupsByKey = new Map<string, BalanceGroup>();
  for (const account of accounts) {
    const key = `${account.rail}|${account.currency}|${account.decimals}`;
    const balance = parseBalanceMinor(account.balanceMinor, String(account._id));
    const group = groupsByKey.get(key);
    if (group) {
      group.subtotal += balance;
      group.accountCount += 1;
    } else {
      groupsByKey.set(key, {
        rail: account.rail,
        currency: account.currency,
        decimals: account.decimals,
        subtotal: balance,
        accountCount: 1,
      });
    }
  }
  const balanceGroups = [...groupsByKey.values()];

  // ONE rate per distinct currency, however many groups share it.
  const currencies = [...new Set(balanceGroups.map((g) => g.currency))];
  const { rates, errors } =
    currencies.length > 0
      ? await getRatesToHome(home, currencies)
      : { rates: new Map<string, RateQuote | null>(), errors: [] as string[] };

  const groups: NetWorthGroup[] = [];
  const unconverted: UnconvertedEntry[] = [];
  const byRailAggregate = new Map<
    string,
    { homeValue: bigint; accountCount: number }
  >();
  let totalHomeMinor = 0n;
  let stale = false;

  for (const group of balanceGroups) {
    const balanceMinor = group.subtotal.toString();
    const quote = rates.get(group.currency) ?? null;

    const railEntry = byRailAggregate.get(group.rail) ?? {
      homeValue: 0n,
      accountCount: 0,
    };
    railEntry.accountCount += group.accountCount;

    if (quote === null) {
      // Unpriced: the group keeps its balance, gets a reason, and is EXCLUDED
      // from the total — loud, never silent.
      const reason = reasonFor(group.currency, home, errors);
      unconverted.push({
        currency: group.currency,
        balanceMinor,
        decimals: group.decimals,
        reason,
      });
      groups.push({
        rail: group.rail,
        currency: group.currency,
        decimals: group.decimals,
        balanceMinor,
        formatted: formatMinor(balanceMinor, group.decimals),
        rate: null,
        rateSource: null,
        rateAsOf: null,
        rateStale: false,
        homeValueMinor: null,
        homeValueFormatted: null,
      });
    } else {
      // The single rounding event for this group's value in home currency.
      const homeValueMinor = convertMinor({
        amountMinor: balanceMinor,
        fromDecimals: group.decimals,
        rateScaled: quote.rateScaled,
        toDecimals: homeDecimals,
      });
      totalHomeMinor += BigInt(homeValueMinor);
      railEntry.homeValue += BigInt(homeValueMinor);
      stale = stale || quote.stale;
      groups.push({
        rail: group.rail,
        currency: group.currency,
        decimals: group.decimals,
        balanceMinor,
        formatted: formatMinor(balanceMinor, group.decimals),
        // Exact decimal rendering of the applied scaled rate, for audit.
        rate: formatMinor(quote.rateScaled.toString(), quote.scale),
        rateSource: quote.source,
        rateAsOf: quote.asOf.toISOString(),
        rateStale: quote.stale,
        homeValueMinor,
        homeValueFormatted: formatMinor(homeValueMinor, homeDecimals),
      });
    }

    byRailAggregate.set(group.rail, railEntry);
  }

  const byRail: NetWorthByRail[] = [...byRailAggregate.entries()].map(
    ([rail, entry]) => ({
      rail,
      homeValueMinor: entry.homeValue.toString(),
      homeValueFormatted: formatMinor(entry.homeValue.toString(), homeDecimals),
      accountCount: entry.accountCount,
    })
  );

  return {
    home,
    homeDecimals,
    totalHomeMinor: totalHomeMinor.toString(),
    totalFormatted: formatMinor(totalHomeMinor.toString(), homeDecimals),
    complete: unconverted.length === 0,
    stale,
    asOf: new Date().toISOString(),
    groups,
    byRail,
    unconverted,
    warnings: errors,
    disclaimer: VALUATION_DISCLAIMER,
  };
};
