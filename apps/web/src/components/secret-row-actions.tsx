import { Button } from "@jomans-vault/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@jomans-vault/ui/components/dropdown-menu";
import { EllipsisIcon } from "lucide-react";
import { useRef } from "react";

export const SecretRowActions = ({
  secretKey,
  onEdit,
  onDelete,
}: {
  secretKey: string;
  onEdit: (opener: HTMLElement) => void;
  onDelete: (opener: HTMLElement) => void;
}) => {
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            ref={trigger}
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${secretKey}`}
          />
        }
      >
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => {
              if (trigger.current) {
                onEdit(trigger.current);
              }
            }}
          >
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              if (trigger.current) {
                onDelete(trigger.current);
              }
            }}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
