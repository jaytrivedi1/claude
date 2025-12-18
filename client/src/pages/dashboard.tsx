import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight, Building2, Wallet, FileText, DollarSign } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrencyCompact } from "@/lib/currencyUtils";
import { cn } from "@/lib/utils";
import {
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";

interface DashboardMetrics {
  profitLoss: {
    netProfit: number;
    percentageChange: number;
    income: number;
    expenses: number;
  };
  expensesByCategory: Array<{ category: string; amount: number }>;
  invoices: {
    unpaid: { count: number; amount: number };
    paid: { count: number; amount: number };
    overdue: { count: number; amount: number };
    deposited: { count: number; amount: number };
  };
  bankAccounts: {
    total: number;
    accounts: Array<{ name: string; balance: number; updated: string }>;
  };
  sales: Array<{ month: string; amount: number }>;
  accountsReceivable: {
    total: number;
    current: number;
    days30: number;
    days60: number;
    days90Plus: number;
  };
}

interface Company {
  id: number;
  name: string;
  logoUrl?: string;
}

const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

// Animation delay helper for staggered animations
const getAnimationDelay = (index: number) => ({
  animationDelay: `${index * 100}ms`,
  animationFillMode: 'backwards' as const,
});

// Metric card component for consistent styling
function MetricCard({
  title,
  value,
  change,
  changeType = 'neutral',
  subtitle,
  icon: Icon,
  index = 0,
  children,
  className,
  testId,
}: {
  title: string;
  value?: string | number;
  change?: number;
  changeType?: 'positive' | 'negative' | 'neutral';
  subtitle?: string;
  icon?: React.ComponentType<{ className?: string }>;
  index?: number;
  children?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Card
      className={cn("animate-fade-in-up", className)}
      style={getAnimationDelay(index)}
      data-testid={testId}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
          {Icon && (
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Icon className="h-4 w-4 text-primary" />
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {value !== undefined && (
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-foreground">{value}</span>
            {change !== undefined && (
              <span className={cn(
                "flex items-center text-sm font-medium",
                changeType === 'positive' && "text-emerald-600",
                changeType === 'negative' && "text-red-500",
                changeType === 'neutral' && "text-muted-foreground"
              )}>
                {changeType === 'positive' && <ArrowUpRight className="h-4 w-4" />}
                {changeType === 'negative' && <ArrowDownRight className="h-4 w-4" />}
                {Math.abs(change).toFixed(1)}%
              </span>
            )}
          </div>
        )}
        {subtitle && (
          <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  // Fetch company data
  const { data: company, isLoading: companyLoading } = useQuery<Company>({
    queryKey: ['/api/companies/default'],
  });

  // Fetch dashboard metrics
  const { data: metrics, isLoading: metricsLoading } = useQuery<DashboardMetrics>({
    queryKey: ['/api/dashboard/metrics'],
  });

  const isLoading = companyLoading || metricsLoading;

  // Prepare Accounts Receivable data for donut chart
  const arData = metrics ? [
    { name: 'Current', value: metrics.accountsReceivable.current },
    { name: '31-60 days', value: metrics.accountsReceivable.days30 },
    { name: '61-90 days', value: metrics.accountsReceivable.days60 },
    { name: '91+ OVER', value: metrics.accountsReceivable.days90Plus },
  ].filter(item => item.value > 0) : [];

  return (
    <div className="py-6 min-h-screen">
      {/* Page Header */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-8 mb-8">
        <div className="flex items-center justify-between animate-fade-in">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              Dashboard
            </h1>
            {company && (
              <p className="text-muted-foreground mt-1" data-testid="company-name">
                {company.name}
              </p>
            )}
          </div>
          {company?.logoUrl && (
            <img
              src={company.logoUrl}
              alt={`${company.name} logo`}
              className="h-12 w-12 object-contain rounded-lg border border-border bg-card p-1.5"
              data-testid="company-logo"
            />
          )}
        </div>
      </div>

      {/* Key Metrics Row */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-8 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Net Profit */}
          {isLoading ? (
            <Card className="animate-fade-in-up" style={getAnimationDelay(0)}>
              <CardContent className="pt-6">
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-8 w-32 mb-2" />
                <Skeleton className="h-4 w-20" />
              </CardContent>
            </Card>
          ) : metrics && (
            <MetricCard
              title="Net Profit"
              value={formatCurrencyCompact(metrics.profitLoss.netProfit, 'CAD', 'CAD')}
              change={metrics.profitLoss.percentageChange}
              changeType={metrics.profitLoss.percentageChange >= 0 ? 'positive' : 'negative'}
              subtitle="Last 30 days"
              icon={TrendingUp}
              index={0}
              testId="card-profit-loss"
            />
          )}

          {/* Total Income */}
          {isLoading ? (
            <Card className="animate-fade-in-up" style={getAnimationDelay(1)}>
              <CardContent className="pt-6">
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-8 w-32 mb-2" />
                <Skeleton className="h-4 w-20" />
              </CardContent>
            </Card>
          ) : metrics && (
            <MetricCard
              title="Income"
              value={formatCurrencyCompact(metrics.profitLoss.income, 'CAD', 'CAD')}
              subtitle="Last 30 days"
              icon={DollarSign}
              index={1}
              testId="card-income"
            />
          )}

          {/* Total Expenses */}
          {isLoading ? (
            <Card className="animate-fade-in-up" style={getAnimationDelay(2)}>
              <CardContent className="pt-6">
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-8 w-32 mb-2" />
                <Skeleton className="h-4 w-20" />
              </CardContent>
            </Card>
          ) : metrics && (
            <MetricCard
              title="Expenses"
              value={formatCurrencyCompact(metrics.profitLoss.expenses, 'CAD', 'CAD')}
              subtitle="Last 30 days"
              icon={Wallet}
              index={2}
              testId="card-expenses-summary"
            />
          )}

          {/* Cash Balance */}
          {isLoading ? (
            <Card className="animate-fade-in-up" style={getAnimationDelay(3)}>
              <CardContent className="pt-6">
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-8 w-32 mb-2" />
                <Skeleton className="h-4 w-20" />
              </CardContent>
            </Card>
          ) : metrics && (
            <MetricCard
              title="Cash Balance"
              value={formatCurrencyCompact(metrics.bankAccounts.total, 'CAD', 'CAD')}
              subtitle="All accounts"
              icon={Building2}
              index={3}
              testId="card-cash-balance"
            />
          )}
        </div>
      </div>

      {/* Charts Row */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-8 mb-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Sales Chart - Takes 2 columns */}
          <Card className="lg:col-span-2 animate-fade-in-up" style={getAnimationDelay(4)} data-testid="card-sales">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Sales Trend</CardTitle>
                <span className="text-sm text-muted-foreground">Year to date</span>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : metrics && metrics.sales.length > 0 ? (
                <div>
                  <div className="text-2xl font-bold mb-4" data-testid="text-total-sales">
                    {formatCurrencyCompact(metrics.sales.reduce((sum, month) => sum + month.amount, 0), 'CAD', 'CAD')}
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={metrics.sales}>
                      <defs>
                        <linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.2}/>
                          <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="month"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={12}
                        tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip
                        formatter={(value) => formatCurrencyCompact(Number(value), 'CAD', 'CAD')}
                        contentStyle={{
                          backgroundColor: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '0.5rem',
                          boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="amount"
                        stroke="hsl(var(--primary))"
                        strokeWidth={2}
                        fill="url(#salesGradient)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="flex items-center justify-center h-64 text-muted-foreground">
                  No sales data available
                </div>
              )}
            </CardContent>
          </Card>

          {/* Expenses by Category */}
          <Card className="animate-fade-in-up" style={getAnimationDelay(5)} data-testid="card-expenses">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Expenses</CardTitle>
                <span className="text-sm text-muted-foreground">Last 30 days</span>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-8 w-32" />
                  <Skeleton className="h-40 w-40 rounded-full mx-auto" />
                </div>
              ) : metrics && metrics.expensesByCategory.length > 0 ? (
                <div>
                  <div className="text-2xl font-bold mb-2" data-testid="text-total-expenses">
                    {formatCurrencyCompact(metrics.expensesByCategory.reduce((sum, cat) => sum + cat.amount, 0), 'CAD', 'CAD')}
                  </div>
                  <ResponsiveContainer width="100%" height={160}>
                    <PieChart>
                      <Pie
                        data={metrics.expensesByCategory}
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={65}
                        fill="#8884d8"
                        paddingAngle={2}
                        dataKey="amount"
                      >
                        {metrics.expensesByCategory.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => formatCurrencyCompact(Number(value), 'CAD', 'CAD')} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-2 mt-2">
                    {metrics.expensesByCategory.slice(0, 3).map((category, index) => (
                      <div key={index} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: COLORS[index % COLORS.length] }}
                          />
                          <span className="text-muted-foreground truncate max-w-[120px]" data-testid={`text-expense-category-${index}`}>
                            {category.category}
                          </span>
                        </div>
                        <span className="font-medium" data-testid={`text-expense-amount-${index}`}>
                          {formatCurrencyCompact(category.amount, 'CAD', 'CAD')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-64 text-muted-foreground">
                  No expense data available
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Bottom Row */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Invoices Card */}
          <Card className="animate-fade-in-up" style={getAnimationDelay(6)} data-testid="card-invoices">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Invoices</CardTitle>
                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <FileText className="h-4 w-4 text-primary" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : metrics ? (
                <div className="space-y-4">
                  {/* Unpaid Section */}
                  <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/30">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-amber-700 dark:text-amber-400">Unpaid</span>
                      <span className="text-sm text-muted-foreground">{metrics.invoices.unpaid.count} invoices</span>
                    </div>
                    <div className="text-xl font-bold text-foreground" data-testid="text-unpaid-label">
                      ${metrics.invoices.unpaid.amount.toLocaleString()}
                    </div>
                    {metrics.invoices.overdue.count > 0 && (
                      <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                        {metrics.invoices.overdue.count} overdue
                      </div>
                    )}
                  </div>

                  {/* Paid Section */}
                  <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/30">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Paid (30 days)</span>
                      <span className="text-sm text-muted-foreground">{metrics.invoices.paid.count} invoices</span>
                    </div>
                    <div className="text-xl font-bold text-foreground" data-testid="text-paid-label">
                      ${metrics.invoices.paid.amount.toLocaleString()}
                    </div>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Bank Accounts Card */}
          <Card className="animate-fade-in-up" style={getAnimationDelay(7)} data-testid="card-bank-accounts">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Bank Accounts</CardTitle>
                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Building2 className="h-4 w-4 text-primary" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                </div>
              ) : metrics ? (
                <div className="space-y-3">
                  <div className="text-2xl font-bold mb-3" data-testid="text-total-balance">
                    {formatCurrencyCompact(metrics.bankAccounts.total, 'CAD', 'CAD')}
                  </div>
                  {metrics.bankAccounts.accounts.slice(0, 2).map((account, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                      data-testid={`bank-account-${index}`}
                    >
                      <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
                        <Building2 className="h-4 w-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate" data-testid={`text-bank-name-${index}`}>
                          {account.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Updated {account.updated}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold text-sm" data-testid={`text-bank-balance-${index}`}>
                          {formatCurrencyCompact(account.balance, 'CAD', 'CAD')}
                        </div>
                      </div>
                    </div>
                  ))}
                  {metrics.bankAccounts.accounts.length > 2 && (
                    <div className="text-sm text-muted-foreground text-center pt-1">
                      +{metrics.bankAccounts.accounts.length - 2} more accounts
                    </div>
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Accounts Receivable Card */}
          <Card className="animate-fade-in-up" style={getAnimationDelay(8)} data-testid="card-accounts-receivable">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold">Accounts Receivable</CardTitle>
                <span className="text-sm text-muted-foreground">Aging</span>
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-8 w-32" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : metrics ? (
                <div>
                  <div className="text-2xl font-bold mb-4" data-testid="text-ar-total">
                    {formatCurrencyCompact(metrics.accountsReceivable.total, 'CAD', 'CAD')}
                  </div>

                  {arData.length > 0 ? (
                    <div className="space-y-2">
                      {arData.map((bucket, index) => {
                        const percentage = metrics.accountsReceivable.total > 0
                          ? (bucket.value / metrics.accountsReceivable.total) * 100
                          : 0;
                        return (
                          <div key={index} className="space-y-1">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground" data-testid={`text-ar-bucket-${index}`}>
                                {bucket.name}
                              </span>
                              <span className="font-medium" data-testid={`text-ar-amount-${index}`}>
                                {formatCurrencyCompact(bucket.value, 'CAD', 'CAD')}
                              </span>
                            </div>
                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{
                                  width: `${percentage}%`,
                                  backgroundColor: COLORS[index % COLORS.length]
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-32 text-muted-foreground">
                      No receivables
                    </div>
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
