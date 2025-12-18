import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { format } from "date-fns";
import { 
  ArrowLeft, 
  FileText, 
  Printer, 
  FileDown, 
  Edit2,
  Mail,
  HelpCircle,
  RefreshCw,
  Link as LinkIcon,
  Send,
  Eye,
  Check,
  FileEdit,
  AlertCircle,
  Clock,
  XCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle 
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useBackNavigation } from "@/hooks/use-back-navigation";
import { useInvoiceTemplate } from "@/hooks/use-invoice-template";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatCurrency, formatContactName } from "@/lib/currencyUtils";
import { Transaction, LineItem, Contact, SalesTax } from "@shared/schema";

export default function InvoiceView() {
  const [, navigate] = useLocation();
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const { toast } = useToast();
  const { backUrl, backLabel, handleBack } = useBackNavigation('/invoices', 'Invoices');
  const { template } = useInvoiceTemplate();
  
  // Send invoice dialog state
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [personalMessage, setPersonalMessage] = useState("");
  const [includePdfAttachment, setIncludePdfAttachment] = useState(true);
  
  // Extract the invoice ID from the URL
  useEffect(() => {
    const path = window.location.pathname;
    const match = path.match(/\/invoices\/(\d+)/);
    if (match && match[1]) {
      setInvoiceId(parseInt(match[1]));
    } else {
      handleBack();
    }
  }, [handleBack]);
  
  // Define extended transaction interface with dueDate
  interface InvoiceWithExtras extends Transaction {
    dueDate: Date | null;
  }

  // Define payment history interfaces
  interface PaymentHistoryItem {
    transaction: Transaction;
    amountApplied: number;
    date: string;
    description: string;
  }

  interface PaymentHistory {
    invoice: Transaction;
    payments: PaymentHistoryItem[];
    summary: {
      originalAmount: number;
      totalPaid: number;
      remainingBalance: number;
    }
  }
  
  // Define invoice activity interface
  interface InvoiceActivity {
    id: number;
    invoiceId: number;
    activityType: 'created' | 'sent' | 'viewed' | 'paid' | 'edited' | 'overdue' | 'reminder_sent' | 'cancelled';
    timestamp: string;
    userId?: number;
    metadata?: any;
  }
  
  // Add a mutation for recalculating the invoice balance
  const recalculateBalanceMutation = useMutation({
    mutationFn: async () => {
      if (!invoiceId) {
        throw new Error('No invoice ID available');
      }
      const response = await apiRequest(
        `/api/transactions/${invoiceId}/recalculate`,
        'POST'
      );
      return response;
    },
    onSuccess: () => {
      // Invalidate relevant queries to refresh the data
      queryClient.invalidateQueries({ queryKey: ['/api/transactions', invoiceId] });
      queryClient.invalidateQueries({ queryKey: ['/api/transactions', invoiceId, 'payment-history'] });
      toast({
        title: "Balance recalculated",
        description: "Invoice balance has been recalculated successfully",
        variant: "default"
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to recalculate",
        description: error.message,
        variant: "destructive"
      });
    }
  });
  
  // Mutation for sending invoice via email
  const sendInvoiceMutation = useMutation({
    mutationFn: async () => {
      if (!invoiceId) {
        throw new Error('No invoice ID available');
      }
      const response = await apiRequest(
        `/api/invoices/${invoiceId}/send-email`,
        'POST',
        {
          recipientEmail,
          recipientName,
          message: personalMessage,
          includeAttachment: includePdfAttachment
        }
      );
      return response;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/invoices', invoiceId, 'activities'] });
      toast({
        title: "Invoice sent",
        description: data.publicLink 
          ? `Invoice sent successfully. Public link: ${data.publicLink}` 
          : "Invoice sent successfully",
        variant: "default"
      });
      setSendDialogOpen(false);
      resetSendForm();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to send invoice",
        description: error.message,
        variant: "destructive"
      });
    }
  });
  
  // Mutation for generating public token
  const generateTokenMutation = useMutation({
    mutationFn: async () => {
      if (!invoiceId) {
        throw new Error('No invoice ID available');
      }
      const response = await apiRequest(
        `/api/invoices/${invoiceId}/generate-token`,
        'POST'
      );
      return response;
    },
    onSuccess: (data) => {
      const publicLink = data.publicLink || '';
      if (publicLink) {
        navigator.clipboard.writeText(publicLink);
        toast({
          title: "Link copied",
          description: "Public invoice link copied to clipboard",
          variant: "default"
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to generate link",
        description: error.message,
        variant: "destructive"
      });
    }
  });
  
  // Fetch invoice details
  const { data: invoiceData, isLoading: invoiceLoading } = useQuery({
    queryKey: ['/api/transactions', invoiceId],
    queryFn: async () => {
      if (!invoiceId) return null;
      const response = await fetch(`/api/transactions/${invoiceId}`);
      if (!response.ok) throw new Error('Failed to fetch invoice');
      return response.json();
    },
    enabled: !!invoiceId
  });
  
  // Fetch contacts for customer info
  const { data: contacts, isLoading: contactsLoading } = useQuery<Contact[]>({
    queryKey: ['/api/contacts'],
  });
  
  // Fetch sales taxes for tax names
  const { data: salesTaxes, isLoading: taxesLoading } = useQuery<SalesTax[]>({
    queryKey: ['/api/sales-taxes'],
  });
  
  // Fetch preferences for home currency
  const { data: preferences } = useQuery<{ homeCurrency?: string }>({
    queryKey: ['/api/settings/preferences'],
  });
  
  const homeCurrency = preferences?.homeCurrency || 'CAD';
  
  // Fetch payment history for this invoice
  const { data: paymentHistory, isLoading: paymentsLoading } = useQuery<PaymentHistory>({
    queryKey: ['/api/transactions', invoiceId, 'payment-history'],
    queryFn: async () => {
      if (!invoiceId) return null;
      const response = await fetch(`/api/transactions/${invoiceId}/payment-history`);
      if (!response.ok) throw new Error('Failed to fetch payment history');
      return response.json();
    },
    enabled: !!invoiceId
  });
  
  // Fetch invoice activities
  const { data: activities = [], isLoading: activitiesLoading } = useQuery<InvoiceActivity[]>({
    queryKey: ['/api/invoices', invoiceId, 'activities'],
    enabled: !!invoiceId
  });
  
  // Extract data once fetched
  const invoice: InvoiceWithExtras | undefined = invoiceData?.transaction;
  const lineItems: LineItem[] = invoiceData?.lineItems || [];
  
  // Find customer
  const customer = contacts?.find(c => c.id === invoice?.contactId);
  
  // Helper function to reset send form
  const resetSendForm = () => {
    setRecipientEmail(customer?.email || "");
    setRecipientName(customer?.name || "");
    setPersonalMessage("");
    setIncludePdfAttachment(true);
  };
  
  // Pre-fill customer data when customer changes or send dialog opens
  useEffect(() => {
    if (sendDialogOpen && customer) {
      setRecipientEmail(customer.email || "");
      setRecipientName(customer.name || "");
    }
  }, [sendDialogOpen, customer]);
  
  // Helper function to get activity icon
  const getActivityIcon = (activityType: string) => {
    switch (activityType) {
      case 'sent':
      case 'reminder_sent':
        return <Mail className="h-4 w-4" />;
      case 'viewed':
        return <Eye className="h-4 w-4" />;
      case 'paid':
        return <Check className="h-4 w-4" />;
      case 'edited':
      case 'created':
        return <FileEdit className="h-4 w-4" />;
      case 'overdue':
        return <AlertCircle className="h-4 w-4" />;
      case 'cancelled':
        return <XCircle className="h-4 w-4" />;
      default:
        return <Clock className="h-4 w-4" />;
    }
  };
  
  // Helper function to format activity type
  const formatActivityType = (activityType: string) => {
    return activityType
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };
  
  // Use saved totals from the transaction (respects manual tax overrides)
  // Fallback to calculating from line items if not saved
  const subtotal = invoice?.subTotal ?? lineItems.reduce((sum, item) => sum + item.amount, 0);
  const totalTaxAmount = invoice?.taxAmount ?? lineItems.reduce((sum, item) => {
    if (!item.salesTaxId || !salesTaxes) return sum;
    const tax = salesTaxes.find(tax => tax.id === item.salesTaxId);
    return sum + (tax ? (item.amount * tax.rate / 100) : 0);
  }, 0);
  const total = invoice?.amount ?? (subtotal + totalTaxAmount);
  
  // Get tax names used in this invoice
  const getTaxNames = (): string[] => {
    if (!salesTaxes || !lineItems) return [];
    
    const taxIds = lineItems
      .filter(item => item.salesTaxId !== null)
      .map(item => item.salesTaxId) as number[];
    
    // Create array of unique tax IDs without using Set
    const uniqueTaxIds: number[] = [];
    taxIds.forEach(id => {
      if (!uniqueTaxIds.includes(id)) {
        uniqueTaxIds.push(id);
      }
    });
    
    return uniqueTaxIds
      .map(id => salesTaxes.find(tax => tax.id === id)?.name)
      .filter(name => name !== undefined) as string[];
  };
  
  const taxNames = getTaxNames();
  
  // Get status badge color
  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'paid':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'overdue':
        return 'bg-red-100 text-red-800';
      case 'draft':
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };
  
  if (invoiceLoading || contactsLoading || taxesLoading || paymentsLoading || activitiesLoading) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-6"></div>
          <div className="h-64 bg-gray-200 rounded mb-6"></div>
          <div className="h-32 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }
  
  if (!invoice) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-4">Invoice not found</h1>
        <p className="mb-4">The invoice you are looking for does not exist or has been deleted.</p>
        <Button onClick={handleBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to {backLabel}
        </Button>
      </div>
    );
  }
  
  return (
    <div className="max-w-5xl mx-auto p-6 animate-fade-in">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={handleBack} className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to {backLabel}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSendDialogOpen(true)}
            data-testid="button-send-invoice"
            className="text-muted-foreground hover:text-foreground"
          >
            <Send className="mr-2 h-4 w-4" />
            Send Invoice
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => generateTokenMutation.mutate()}
            disabled={generateTokenMutation.isPending}
            data-testid="button-copy-link"
            className="text-muted-foreground hover:text-foreground"
          >
            <LinkIcon className="mr-2 h-4 w-4" />
            Copy Link
          </Button>
          <Link href={`/invoices/${invoice.id}/edit`}>
            <Button size="sm" data-testid="button-edit-invoice">
              <Edit2 className="mr-2 h-4 w-4" />
              Edit
            </Button>
          </Link>
        </div>
      </div>

      {/* Invoice Details */}
      <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
        {/* Invoice header with status */}
        <div className="px-6 py-5 border-b border-border flex justify-between items-center bg-muted/30">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <FileText className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">Invoice #{invoice.reference}</h1>
              <p className="text-muted-foreground text-sm">
                {invoice.date ? format(new Date(invoice.date), 'MMMM d, yyyy') : 'No date'}
              </p>
            </div>
          </div>
          <Badge
            className={`px-3 py-1.5 text-sm font-medium ${getStatusColor(invoice.status)}`}
          >
            {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
          </Badge>
        </div>
        
        {/* Invoice body */}
        <div className="px-6 py-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            {/* Left side - From/To */}
            <div className="space-y-6">
              <div className="p-4 rounded-xl bg-muted/30 border border-border">
                <h2 className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">From</h2>
                <p className="font-medium text-foreground">Your Company Name</p>
                <p className="text-muted-foreground text-sm">123 Business Avenue</p>
                <p className="text-muted-foreground text-sm">Business City, State 12345</p>
                <p className="text-muted-foreground text-sm">accounting@yourcompany.com</p>
              </div>

              <div className="p-4 rounded-xl bg-muted/30 border border-border">
                <h2 className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">Bill To</h2>
                {customer ? (
                  <>
                    <p className="font-medium text-foreground">{formatContactName(customer.name, customer.currency, homeCurrency)}</p>
                    {customer.contactName && <p className="text-muted-foreground text-sm">{customer.contactName}</p>}
                    {customer.address && <p className="text-muted-foreground text-sm">{customer.address}</p>}
                    {customer.email && <p className="text-muted-foreground text-sm">{customer.email}</p>}
                  </>
                ) : (
                  <p className="text-muted-foreground text-sm">No customer information</p>
                )}
              </div>
            </div>

            {/* Right side - Payment details */}
            <div className="p-4 rounded-xl bg-muted/30 border border-border space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground text-sm">Invoice Number</span>
                <span className="font-medium text-foreground">{invoice.reference}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground text-sm">Invoice Date</span>
                <span className="text-foreground">{invoice.date ? format(new Date(invoice.date), 'MMMM d, yyyy') : 'No date'}</span>
              </div>
              {/* Due Date - only show if available */}
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground text-sm">Due Date</span>
                <span className="text-foreground">
                  {invoice.dueDate
                    ? format(new Date(invoice.dueDate), 'MMMM d, yyyy')
                    : 'Not specified'
                  }
                </span>
              </div>
              <div className="flex justify-between items-center pt-3 border-t border-border">
                <span className="font-medium text-foreground">Amount Due</span>
                <span className="text-xl font-bold text-primary">{formatCurrency(invoice.amount || 0, invoice.currency, homeCurrency)}</span>
              </div>
            </div>
          </div>
          
          {/* Line Items */}
          <div className="mb-8">
            <h2 className="text-base font-semibold mb-4 text-foreground">Line Items</h2>
            <div className="rounded-xl border border-border overflow-hidden">
              <div className="grid grid-cols-8 gap-4 px-4 py-3 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <div className="col-span-3">Description</div>
                <div className="col-span-1 text-center">Qty</div>
                <div className="col-span-1 text-center">Rate</div>
                <div className="col-span-1 text-center">Tax</div>
                <div className="col-span-2 text-right">Amount</div>
              </div>

              {lineItems.length > 0 ? (
                <div className="divide-y divide-border">
                  {lineItems.map((item, index) => {
                    const tax = item.salesTaxId ? salesTaxes?.find(t => t.id === item.salesTaxId) : null;

                    return (
                      <div key={index} className="grid grid-cols-8 gap-4 px-4 py-4 items-center hover:bg-muted/30 transition-colors">
                        <div className="col-span-3">
                          <p className="font-medium text-foreground">{item.description}</p>
                        </div>
                        <div className="col-span-1 text-center text-muted-foreground">{item.quantity}</div>
                        <div className="col-span-1 text-center text-muted-foreground">{formatCurrency(item.unitPrice, invoice.currency, homeCurrency)}</div>
                        <div className="col-span-1 text-center text-muted-foreground text-sm">
                          {tax ? `${tax.name} (${tax.rate}%)` : '-'}
                        </div>
                        <div className="col-span-2 text-right font-medium text-foreground">{formatCurrency(item.amount, invoice.currency, homeCurrency)}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-muted-foreground">
                  No items
                </div>
              )}
            </div>
          </div>
          
          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-80 p-5 rounded-xl bg-muted/30 border border-border space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground text-sm">Subtotal</span>
                <span className="font-medium text-foreground">{formatCurrency(subtotal, invoice.currency, homeCurrency)}</span>
              </div>

              {totalTaxAmount > 0 && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground text-sm">
                    {taxNames.length > 0
                      ? taxNames.join(', ')
                      : 'Tax'}
                  </span>
                  <span className="text-foreground">{formatCurrency(totalTaxAmount, invoice.currency, homeCurrency)}</span>
                </div>
              )}

              <div className="flex justify-between items-center pt-3 border-t border-border">
                <span className="font-semibold text-foreground">Total</span>
                <span className="font-semibold text-foreground">{formatCurrency(total, invoice.currency, homeCurrency)}</span>
              </div>

              {/* Use payment history values for accurate numbers */}
              {(paymentHistory?.summary?.totalPaid || 0) > 0 && (
                <div className="flex justify-between items-center text-emerald-600">
                  <span className="text-sm">Amount Paid</span>
                  <span className="font-medium">
                    -{formatCurrency(paymentHistory?.summary?.totalPaid || 0, invoice.currency, homeCurrency)}
                  </span>
                </div>
              )}

              <div className="flex justify-between items-center pt-4 border-t-2 border-primary/30">
                <span className="font-bold text-foreground">Balance Due</span>
                <span className="text-xl font-bold text-primary">
                  {formatCurrency(
                    // Calculate balance due as follows:
                    // 1. Start with invoice total
                    // 2. Subtract any payments from payment history
                    // 3. Subtract any applied credits
                    invoice.balance !== null && invoice.balance !== undefined
                    ? Math.max(0, invoice.balance)
                    : Math.max(0, (total - (paymentHistory?.summary?.totalPaid || 0))),
                    invoice.currency,
                    homeCurrency
                  )}
                </span>
              </div>

              {paymentHistory && paymentHistory.summary && (
                <div className="text-xs text-muted-foreground text-right pt-2">
                  * Based on payment history shown below
                </div>
              )}
            </div>
          </div>
          
          {/* Payment History */}
          {paymentHistory && paymentHistory.payments && paymentHistory.payments.length > 0 && (
            <div className="mt-8 border-t pt-4">
              <h2 className="text-lg font-medium mb-3">Payment History</h2>
              <div className="bg-gray-50 rounded-md">
                <div className="grid grid-cols-12 gap-4 px-4 py-3 border-b text-sm font-medium text-gray-500">
                  <div className="col-span-3">Date</div>
                  <div className="col-span-3">Transaction</div>
                  <div className="col-span-4">Description</div>
                  <div className="col-span-2 text-right">Amount</div>
                </div>
                <div className="divide-y">
                  {paymentHistory.payments.map((payment, index) => (
                    <div key={index} className="grid grid-cols-12 gap-4 px-4 py-3 items-center">
                      <div className="col-span-3">
                        {payment.date && format(new Date(payment.date), 'MMM d, yyyy')}
                      </div>
                      <div className="col-span-3">
                        <div className="font-medium">{payment.transaction.type.replace('_', ' ')}</div>
                        <div className="text-sm text-gray-500">#{payment.transaction.reference || payment.transaction.id}</div>
                      </div>
                      <div className="col-span-4 text-gray-600">
                        {payment.description}
                      </div>
                      <div className="col-span-2 text-right font-medium">
                        {formatCurrency(payment.amountApplied, invoice.currency, homeCurrency)}
                      </div>
                    </div>
                  ))}
                </div>
                
                {/* Summary row */}
                <div className="px-4 py-3 bg-gray-100 grid grid-cols-12 gap-4 font-medium">
                  <div className="col-span-10 text-right">Total Applied:</div>
                  <div className="col-span-2 text-right">{formatCurrency(paymentHistory.summary.totalPaid, invoice.currency, homeCurrency)}</div>
                </div>
              </div>
              
              {/* Balance calculation */}
              <div className="mt-4 bg-blue-50 p-4 rounded-md">
                <div className="grid grid-cols-2 gap-2">
                  <div className="text-gray-700">Original Amount:</div>
                  <div className="text-right">{formatCurrency(paymentHistory.summary.originalAmount, invoice.currency, homeCurrency)}</div>
                  
                  <div className="text-gray-700">Total Payments:</div>
                  <div className="text-right">- {formatCurrency(paymentHistory.summary.totalPaid, invoice.currency, homeCurrency)}</div>
                  
                  <div className="text-gray-800 font-medium pt-2 border-t border-blue-200">Current Balance:</div>
                  <div className="text-right font-medium pt-2 border-t border-blue-200">
                    {formatCurrency(paymentHistory.summary.remainingBalance, invoice.currency, homeCurrency)}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Notes */}
          {invoice.description && (
            <div className="mt-8 border-t pt-4">
              <h2 className="text-lg font-medium mb-2">Notes</h2>
              <p className="text-gray-600">{invoice.description}</p>
            </div>
          )}
        </div>
        
        {/* Footer */}
        <div className="px-6 py-5 bg-muted/30 border-t border-border text-center">
          <p className="text-sm text-muted-foreground">Thank you for your business!</p>
        </div>
      </div>

      {/* Activity Timeline */}
      <Card className="mt-6 rounded-xl border-border">
        <CardHeader>
          <CardTitle className="text-base font-semibold text-foreground">Activity Timeline</CardTitle>
          <CardDescription className="text-muted-foreground">Track all actions performed on this invoice</CardDescription>
        </CardHeader>
        <CardContent>
          {activities.length === 0 ? (
            <div className="text-center py-8 text-gray-500" data-testid="text-no-activity">
              <Clock className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No activity yet</p>
            </div>
          ) : (
            <div className="space-y-4">
              {activities.map((activity, index) => (
                <div 
                  key={activity.id} 
                  className="flex gap-4 items-start"
                  data-testid={`activity-item-${index}`}
                >
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                    {getActivityIcon(activity.activityType)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-sm" data-testid={`activity-type-${index}`}>
                        {formatActivityType(activity.activityType)}
                      </p>
                      <p className="text-xs text-gray-500" data-testid={`activity-timestamp-${index}`}>
                        {format(new Date(activity.timestamp), 'MMM d, yyyy h:mm a')}
                      </p>
                    </div>
                    {activity.metadata?.email && (
                      <p className="text-sm text-gray-600 mt-1">
                        Sent to {activity.metadata.email}
                      </p>
                    )}
                    {activity.userId && (
                      <p className="text-xs text-gray-500 mt-1">
                        By user #{activity.userId}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Send Invoice Dialog */}
      <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
        <DialogContent className="sm:max-w-[500px]" data-testid="dialog-send-invoice" aria-describedby="send-invoice-description">
          <DialogHeader>
            <DialogTitle>Send Invoice</DialogTitle>
            <DialogDescription id="send-invoice-description">
              Send this invoice via email to the customer
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="recipientEmail">Recipient Email *</Label>
              <Input
                id="recipientEmail"
                type="email"
                placeholder="customer@example.com"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                data-testid="input-recipient-email"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="recipientName">Recipient Name</Label>
              <Input
                id="recipientName"
                type="text"
                placeholder="Customer Name"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                data-testid="input-recipient-name"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="personalMessage">Personal Message (Optional)</Label>
              <Textarea
                id="personalMessage"
                placeholder="Add a personal message to include in the email..."
                value={personalMessage}
                onChange={(e) => setPersonalMessage(e.target.value)}
                rows={4}
                data-testid="textarea-personal-message"
              />
            </div>
            
            <div className="flex items-center space-x-2">
              <Checkbox
                id="includePdf"
                checked={includePdfAttachment}
                onCheckedChange={(checked) => setIncludePdfAttachment(checked === true)}
                data-testid="checkbox-include-pdf"
              />
              <Label htmlFor="includePdf" className="cursor-pointer">
                Include PDF attachment
              </Label>
            </div>
          </div>
          
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSendDialogOpen(false)}
              data-testid="button-cancel-send"
            >
              Cancel
            </Button>
            <Button
              onClick={() => sendInvoiceMutation.mutate()}
              disabled={!recipientEmail || sendInvoiceMutation.isPending}
              data-testid="button-submit-send"
            >
              {sendInvoiceMutation.isPending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Send Invoice
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}