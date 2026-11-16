import { Suspense } from "react";
import { RedirectIfSignedIn } from "@/components/auth/redirect-if-signed-in";
import { SignUpForm } from "@/components/auth/sign-up-form";

export const metadata = { title: "Create account" };

export default function SignUpPage() {
  return (
    <>
      <Suspense fallback={null}>
        <RedirectIfSignedIn />
      </Suspense>
      <SignUpForm />
    </>
  );
}
