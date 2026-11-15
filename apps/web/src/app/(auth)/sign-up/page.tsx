import { SignUpForm } from "@/components/auth/sign-up-form";

export const metadata = { title: "Create account" };

// Signed-in visitors are redirected to /inbox by proxy.ts before this renders.
export default function SignUpPage() {
  return <SignUpForm />;
}
