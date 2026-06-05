import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
import { useResetPasswordMutation } from "@/features/auth/authAPI";

const schema = z
  .object({
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    message: "Passwords don't match",
    path: ["confirm"],
  });

type FormValues = z.infer<typeof schema>;

const ResetPassword = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [resetPassword, { isLoading }] = useResetPasswordMutation();
  const form = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = (values: FormValues) => {
    resetPassword({ token, password: values.password })
      .unwrap()
      .then(() => {
        toast.success("Your password has been reset. You can sign in now.");
        navigate(AUTH_ROUTES.SIGN_IN);
      })
      .catch((error) => {
        toast.error(
          error.data?.message || "This reset link is invalid or has expired."
        );
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
            {!token ? (
              <div className="flex flex-col gap-4 text-center">
                <h1 className="text-2xl font-bold">Invalid reset link</h1>
                <p className="text-sm text-muted-foreground">
                  This link is missing its token. Request a new one.
                </p>
                <Link
                  to={AUTH_ROUTES.FORGOT_PASSWORD}
                  className="text-sm underline underline-offset-4"
                >
                  Request a new link
                </Link>
              </div>
            ) : (
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onSubmit)}
                  className="flex flex-col gap-6"
                >
                  <div className="flex flex-col items-center gap-2 text-center">
                    <h1 className="text-2xl font-bold">Set a new password</h1>
                    <p className="text-balance text-sm text-muted-foreground">
                      Choose a new password for your account.
                    </p>
                  </div>
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>New password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="************"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="confirm"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Confirm password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="************"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button disabled={isLoading} type="submit" className="w-full">
                    {isLoading && <Loader className="h-4 w-4 animate-spin" />}
                    Reset password
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

export default ResetPassword;
