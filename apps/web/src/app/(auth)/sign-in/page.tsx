import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata = { title: "Sign in" };

// Signed-in visitors are redirected to /inbox by proxy.ts before this renders.
export default function SignInPage() {
  return <SignInForm />;
}
