import { useEffect, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Loader, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateAccountMutation } from "@/features/account/accountAPI";
import { RAIL_ENUM, RailType } from "@/features/account/accountType";

const RAIL_OPTIONS: { value: RailType; label: string }[] = [
  { value: RAIL_ENUM.STRIPE, label: "Stripe" },
  { value: RAIL_ENUM.BANK, label: "Bank" },
  { value: RAIL_ENUM.CRYPTO, label: "Crypto" },
  { value: RAIL_ENUM.CASH, label: "Cash" },
  { value: RAIL_ENUM.PLATFORM_CREDIT, label: "Platform credit" },
  { value: RAIL_ENUM.GIFT_CARD, label: "Gift card" },
];

// Sensible minor-unit scales for common currencies — prefills the decimals
// field when the currency matches; still editable for anything exotic.
// Zero- and three-decimal fiat is listed too: leaving JPY at the default 2
// would misread every minor-unit balance 100x (the backend corrects it on
// first sync and refuses after, but the right value from the start is better).
const CURRENCY_DECIMALS: Record<string, number> = {
  GBP: 2,
  USD: 2,
  EUR: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
  BHD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  BTC: 8,
  ETH: 18,
  USDC: 6,
};

const formSchema = z.object({
  rail: z.enum([
    RAIL_ENUM.STRIPE,
    RAIL_ENUM.BANK,
    RAIL_ENUM.CRYPTO,
    RAIL_ENUM.CASH,
    RAIL_ENUM.PLATFORM_CREDIT,
    RAIL_ENUM.GIFT_CARD,
  ]),
  displayName: z.string().trim().min(1, "Display name is required"),
  currency: z
    .string()
    .trim()
    .min(2, "Currency is required")
    .max(10, "Max 10 characters"),
  decimals: z
    .string()
    .trim()
    .regex(/^\d{1,2}$/, "Whole number between 0 and 30")
    .refine((v) => Number(v) <= 30, "Max 30"),
});

type FormValues = z.infer<typeof formSchema>;

const AddAccountDialog = ({ trigger }: { trigger?: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const [createAccount, { isLoading }] = useCreateAccountMutation();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      rail: RAIL_ENUM.BANK,
      displayName: "",
      currency: "USD",
      decimals: "2",
    },
  });

  // Prefill decimals from the currency (GBP/USD/EUR → 2, BTC → 8, ETH → 18,
  // USDC → 6) whenever the currency matches a known one.
  const currency = form.watch("currency");
  useEffect(() => {
    const known = CURRENCY_DECIMALS[currency?.trim().toUpperCase()];
    if (known !== undefined) {
      form.setValue("decimals", String(known));
    }
  }, [currency, form]);

  const handleClose = () => {
    setOpen(false);
    setTimeout(() => form.reset(), 300);
  };

  const onSubmit = (values: FormValues) => {
    createAccount({
      rail: values.rail,
      displayName: values.displayName,
      currency: values.currency.toUpperCase(),
      decimals: Number(values.decimals),
    })
      .unwrap()
      .then(() => {
        toast.success("Account created successfully");
        handleClose();
      })
      .catch((error) => {
        toast.error(error.data?.message || "Failed to create account");
      });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : handleClose())}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button className="!cursor-pointer !px-6 !text-white">
            <PlusIcon className="h-4 w-4" />
            <span>Add account</span>
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add account</DialogTitle>
          <DialogDescription>
            A labelled balance container on a rail — a cash float, a gift card,
            a wallet. Connector-backed accounts are onboarded separately.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <FormField
              control={form.control}
              name="rail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rail</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl className="w-full">
                      <SelectTrigger>
                        <SelectValue placeholder="Select a rail" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {RAIL_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Display name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Market stall cash float" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Currency</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="GBP, BTC…"
                        className="uppercase"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="decimals"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Decimals</FormLabel>
                    <FormControl>
                      <Input inputMode="numeric" placeholder="2" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <Button
              type="submit"
              disabled={isLoading}
              className="w-full !text-white"
            >
              {isLoading && <Loader className="h-4 w-4 animate-spin" />}
              Add account
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default AddAccountDialog;
