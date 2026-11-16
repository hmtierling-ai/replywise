import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyInbox({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
      <div className="grid size-10 place-items-center rounded-full bg-muted">
        <Inbox className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <h1 className="text-base font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
