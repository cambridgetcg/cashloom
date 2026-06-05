import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "react-router-dom";
import { Loader } from "lucide-react";
import { toast } from "sonner";
import Logo from "@/components/logo/logo";
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
import { AUTH_ROUTES } from "@/routes/common/routePath";
import { useForgotPasswordMutation } from "@/features/auth/authAPI";

const schema = z.object({
  email: z.string().email("Invalid email address"),
});

type FormValues = z.infer<typeof schema>;

const ForgotPassword = () => {
  const [sent, setSent] = useState(false);
  const [forgotPassword, { isLoading }] = useForgotPasswordMutation();
  const form = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = (values: FormValues) => {
    forgotPassword(values)
      .unwrap()
      .then(() => setSent(true))
      .catch((error) => {
        toast.error(error.data?.message || "Something went wrong. Try again.");
      });
  };

  return (
    <div className="min-h-svh">
      <div className="flex flex-col gap-4 p-6 md:p-10 md:pt-6">
        <div className="flex justify-center gap-2 md:justify-start">
          <Logo url="/" />
        </div>
        <div className="flex flex-1 mt-8 items-center justify-center">
          <div className="w-full max-w-xs">
            {sent ? (
              <div className="flex flex-col gap-4 text-center">
                <h1 className="text-2xl font-bold">Check your email</h1>
                <p className="text-sm text-muted-foreground">
                  If that email is registered, a reset link is on its way. The
                  link expires in 30 minutes.
                </p>
                <Link
                  to={AUTH_ROUTES.SIGN_IN}
                  className="text-sm underline underline-offset-4"
                >
                  Back to sign in
                </Link>
              </div>
            ) : (
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onSubmit)}
                  className="flex flex-col gap-6"
                >
                  <div className="flex flex-col items-center gap-2 text-center">
                    <h1 className="text-2xl font-bold">Forgot your password?</h1>
                    <p className="text-balance text-sm text-muted-foreground">
                      Enter your email and we'll send a reset link.
                    </p>
                  </div>
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input placeholder="test@example.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button disabled={isLoading} type="submit" className="w-full">
                    {isLoading && <Loader className="h-4 w-4 animate-spin" />}
                    Send reset link
                  </Button>
                  <div className="text-center text-sm">
                    <Link
                      to={AUTH_ROUTES.SIGN_IN}
                      className="underline underline-offset-4"
                    >
                      Back to sign in
                    </Link>
                  </div>
                </form>
              </Form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ForgotPassword;
