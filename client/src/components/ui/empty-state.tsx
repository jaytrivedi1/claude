import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  FileText,
  Receipt,
  Users,
  Package,
  Building2,
  CreditCard,
  TrendingUp,
  Search,
  FolderOpen,
  Plus,
  type LucideIcon,
} from "lucide-react";

// Pre-defined illustrations for common empty states
const illustrations: Record<string, LucideIcon> = {
  invoices: FileText,
  expenses: Receipt,
  customers: Users,
  vendors: Users,
  products: Package,
  accounts: Building2,
  transactions: CreditCard,
  reports: TrendingUp,
  search: Search,
  default: FolderOpen,
};

interface EmptyStateProps {
  icon?: LucideIcon | keyof typeof illustrations;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionIcon?: LucideIcon;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function EmptyState({
  icon = "default",
  title,
  description,
  actionLabel,
  onAction,
  actionIcon: ActionIcon = Plus,
  className,
  size = "md",
}: EmptyStateProps) {
  // Get the icon component
  const IconComponent = typeof icon === "string" ? illustrations[icon] || illustrations.default : icon;

  const sizeClasses = {
    sm: {
      container: "py-8",
      icon: "w-10 h-10",
      iconWrapper: "w-16 h-16",
      title: "text-base",
      description: "text-sm",
    },
    md: {
      container: "py-12",
      icon: "w-12 h-12",
      iconWrapper: "w-20 h-20",
      title: "text-lg",
      description: "text-sm",
    },
    lg: {
      container: "py-16",
      icon: "w-16 h-16",
      iconWrapper: "w-24 h-24",
      title: "text-xl",
      description: "text-base",
    },
  };

  const sizes = sizeClasses[size];

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        sizes.container,
        className
      )}
    >
      {/* Icon with decorative background */}
      <div
        className={cn(
          "rounded-full bg-muted flex items-center justify-center mb-4",
          sizes.iconWrapper
        )}
      >
        <IconComponent
          className={cn("text-muted-foreground", sizes.icon)}
          strokeWidth={1.5}
        />
      </div>

      {/* Title */}
      <h3 className={cn("font-semibold text-foreground mb-1", sizes.title)}>
        {title}
      </h3>

      {/* Description */}
      {description && (
        <p className={cn("text-muted-foreground max-w-sm mb-4", sizes.description)}>
          {description}
        </p>
      )}

      {/* Action button */}
      {actionLabel && onAction && (
        <Button onClick={onAction} size={size === "sm" ? "sm" : "default"}>
          <ActionIcon className="w-4 h-4 mr-2" />
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

// Specialized empty states for common scenarios
export function NoInvoicesEmpty({ onCreateInvoice }: { onCreateInvoice?: () => void }) {
  return (
    <EmptyState
      icon="invoices"
      title="No invoices yet"
      description="Create your first invoice to start tracking your income and get paid faster."
      actionLabel="Create Invoice"
      onAction={onCreateInvoice}
    />
  );
}

export function NoExpensesEmpty({ onCreateExpense }: { onCreateExpense?: () => void }) {
  return (
    <EmptyState
      icon="expenses"
      title="No expenses recorded"
      description="Track your business expenses to manage cash flow and prepare for tax time."
      actionLabel="Add Expense"
      onAction={onCreateExpense}
    />
  );
}

export function NoCustomersEmpty({ onAddCustomer }: { onAddCustomer?: () => void }) {
  return (
    <EmptyState
      icon="customers"
      title="No customers yet"
      description="Add your first customer to start creating invoices and tracking payments."
      actionLabel="Add Customer"
      onAction={onAddCustomer}
    />
  );
}

export function NoVendorsEmpty({ onAddVendor }: { onAddVendor?: () => void }) {
  return (
    <EmptyState
      icon="vendors"
      title="No vendors yet"
      description="Add vendors to track bills, expenses, and manage your payables."
      actionLabel="Add Vendor"
      onAction={onAddVendor}
    />
  );
}

export function NoProductsEmpty({ onAddProduct }: { onAddProduct?: () => void }) {
  return (
    <EmptyState
      icon="products"
      title="No products or services"
      description="Add products and services to quickly add them to invoices and quotes."
      actionLabel="Add Product"
      onAction={onAddProduct}
    />
  );
}

export function NoSearchResultsEmpty({ query }: { query?: string }) {
  return (
    <EmptyState
      icon="search"
      title="No results found"
      description={
        query
          ? `We couldn't find anything matching "${query}". Try a different search term.`
          : "Try adjusting your search or filters to find what you're looking for."
      }
      size="sm"
    />
  );
}

export function NoTransactionsEmpty() {
  return (
    <EmptyState
      icon="transactions"
      title="No transactions"
      description="Transactions will appear here once you create invoices, expenses, or other entries."
      size="sm"
    />
  );
}
