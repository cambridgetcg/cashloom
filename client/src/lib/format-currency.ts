// App-wide display currency (the i18n pattern — set once from the logged-in
// user, read by every formatCurrency call so the whole app shows their
// currency without threading it through each call site). Not FX: amounts are
// shown as entered, just with the right symbol.
let activeCurrency = "USD";

export const setActiveCurrency = (currency?: string) => {
  if (currency) activeCurrency = currency;
};

export const formatCurrency = (value: number,
  options: {
    currency?: string;
    decimalPlaces?: number;
    compact?: boolean;
    showSign?: boolean;
    isExpense?: boolean;
  } = {}
):string => {
  const { currency = activeCurrency, decimalPlaces = 2, compact = false, showSign = false, isExpense = false } = options;

  const displayValue = isExpense ? -Math.abs(value) : value;
  
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
    notation: compact ? 'compact' : 'standard',
    //signDisplay: showSign  ? 'always' : isExpense ? 'always' : 'auto',
    signDisplay: showSign ? 'always' : 'auto',
  }).format(displayValue);
};
