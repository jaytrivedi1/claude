"use client"

import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  FileText,
  ArrowUpRight,
  ArrowDownRight,
  Plus,
  Search,
  Bell,
} from "lucide-react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts"

import { SidebarProvider, SidebarTrigger, SidebarInset } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@/components/ui/breadcrumb"

// Sample data for charts
const revenueData = [
  { month: "Jan", income: 18500, expenses: 12400 },
  { month: "Feb", income: 22300, expenses: 14200 },
  { month: "Mar", income: 19800, expenses: 11800 },
  { month: "Apr", income: 24500, expenses: 15600 },
  { month: "May", income: 28900, expenses: 17200 },
  { month: "Jun", income: 32100, expenses: 19400 },
]

const expenseBreakdown = [
  { name: "Payroll", value: 45000, color: "hsl(221, 83%, 53%)" },
  { name: "Rent", value: 12000, color: "hsl(142, 76%, 36%)" },
  { name: "Utilities", value: 3500, color: "hsl(38, 92%, 50%)" },
  { name: "Marketing", value: 8000, color: "hsl(280, 65%, 60%)" },
  { name: "Software", value: 5500, color: "hsl(0, 84%, 60%)" },
]

const cashFlowData = [
  { week: "Week 1", inflow: 12500, outflow: 8200 },
  { week: "Week 2", inflow: 15800, outflow: 11400 },
  { week: "Week 3", inflow: 9200, outflow: 7600 },
  { week: "Week 4", inflow: 18400, outflow: 12800 },
]

const recentTransactions = [
  {
    id: "TXN001",
    description: "Payment from Acme Corp",
    type: "income",
    amount: 4500.00,
    date: "Dec 14, 2024",
    category: "Invoice Payment",
    status: "completed",
  },
  {
    id: "TXN002",
    description: "Office Supplies - Staples",
    type: "expense",
    amount: 234.50,
    date: "Dec 14, 2024",
    category: "Office Expenses",
    status: "completed",
  },
  {
    id: "TXN003",
    description: "Monthly Rent Payment",
    type: "expense",
    amount: 3000.00,
    date: "Dec 13, 2024",
    category: "Rent",
    status: "completed",
  },
  {
    id: "TXN004",
    description: "Payment from TechStart Inc",
    type: "income",
    amount: 8750.00,
    date: "Dec 13, 2024",
    category: "Invoice Payment",
    status: "pending",
  },
  {
    id: "TXN005",
    description: "AWS Cloud Services",
    type: "expense",
    amount: 1250.00,
    date: "Dec 12, 2024",
    category: "Software",
    status: "completed",
  },
]

const outstandingInvoices = [
  {
    id: "INV-2024-089",
    customer: "Acme Corporation",
    amount: 12500.00,
    dueDate: "Dec 20, 2024",
    status: "overdue",
    daysOverdue: 5,
  },
  {
    id: "INV-2024-092",
    customer: "TechStart Inc",
    amount: 8750.00,
    dueDate: "Dec 25, 2024",
    status: "pending",
    daysOverdue: 0,
  },
  {
    id: "INV-2024-095",
    customer: "Global Systems",
    amount: 15200.00,
    dueDate: "Dec 28, 2024",
    status: "pending",
    daysOverdue: 0,
  },
]

const upcomingBills = [
  {
    id: "BILL-001",
    vendor: "Office Space LLC",
    amount: 3000.00,
    dueDate: "Dec 31, 2024",
    category: "Rent",
  },
  {
    id: "BILL-002",
    vendor: "Electric Company",
    amount: 450.00,
    dueDate: "Jan 5, 2025",
    category: "Utilities",
  },
  {
    id: "BILL-003",
    vendor: "Internet Provider",
    amount: 199.00,
    dueDate: "Jan 10, 2025",
    category: "Utilities",
  },
]

export default function Dashboard() {
  const totalExpenses = expenseBreakdown.reduce((sum, item) => sum + item.value, 0)

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Dashboard</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search..."
                className="w-64 pl-8"
              />
            </div>
            <Button variant="ghost" size="icon">
              <Bell className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Create
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem>New Invoice</DropdownMenuItem>
                <DropdownMenuItem>New Expense</DropdownMenuItem>
                <DropdownMenuItem>New Customer</DropdownMenuItem>
                <DropdownMenuItem>New Bill</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-6">
          <div className="mb-6">
            <h1 className="text-2xl font-bold">Welcome back, John</h1>
            <p className="text-muted-foreground">
              Here&apos;s what&apos;s happening with your business today.
            </p>
          </div>

          {/* Summary Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
                <DollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">$146,100</div>
                <div className="flex items-center text-xs text-green-600">
                  <ArrowUpRight className="mr-1 h-3 w-3" />
                  +12.5% from last month
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Total Expenses</CardTitle>
                <TrendingDown className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">$90,600</div>
                <div className="flex items-center text-xs text-red-600">
                  <ArrowDownRight className="mr-1 h-3 w-3" />
                  +8.2% from last month
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Net Profit</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">$55,500</div>
                <div className="flex items-center text-xs text-green-600">
                  <ArrowUpRight className="mr-1 h-3 w-3" />
                  +18.3% from last month
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Outstanding Invoices</CardTitle>
                <FileText className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">$36,450</div>
                <div className="flex items-center text-xs text-muted-foreground">
                  3 invoices pending
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Charts Row */}
          <div className="grid gap-4 lg:grid-cols-7 mb-6">
            <Card className="lg:col-span-4">
              <CardHeader>
                <CardTitle>Revenue vs Expenses</CardTitle>
                <CardDescription>Monthly comparison for the last 6 months</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={revenueData}>
                      <defs>
                        <linearGradient id="incomeGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="expenseGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(0, 84%, 60%)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(0, 84%, 60%)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="month" className="text-xs" />
                      <YAxis className="text-xs" tickFormatter={(value) => `$${value / 1000}k`} />
                      <Tooltip
                        formatter={(value: number) => [`$${value.toLocaleString()}`, '']}
                        contentStyle={{
                          backgroundColor: 'hsl(var(--popover))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="income"
                        stroke="hsl(142, 76%, 36%)"
                        fill="url(#incomeGradient)"
                        strokeWidth={2}
                        name="Income"
                      />
                      <Area
                        type="monotone"
                        dataKey="expenses"
                        stroke="hsl(0, 84%, 60%)"
                        fill="url(#expenseGradient)"
                        strokeWidth={2}
                        name="Expenses"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>Expense Breakdown</CardTitle>
                <CardDescription>Where your money goes</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={expenseBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        paddingAngle={2}
                        dataKey="value"
                      >
                        {expenseBreakdown.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value: number) => [`$${value.toLocaleString()}`, '']}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-4 space-y-2">
                  {expenseBreakdown.map((item) => (
                    <div key={item.name} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-3 w-3 rounded-full"
                          style={{ backgroundColor: item.color }}
                        />
                        <span>{item.name}</span>
                      </div>
                      <span className="text-muted-foreground">
                        {((item.value / totalExpenses) * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Cash Flow Chart */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Cash Flow</CardTitle>
              <CardDescription>Weekly cash inflow and outflow</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={cashFlowData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="week" className="text-xs" />
                    <YAxis className="text-xs" tickFormatter={(value) => `$${value / 1000}k`} />
                    <Tooltip
                      formatter={(value: number) => [`$${value.toLocaleString()}`, '']}
                      contentStyle={{
                        backgroundColor: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                      }}
                    />
                    <Bar dataKey="inflow" fill="hsl(142, 76%, 36%)" radius={[4, 4, 0, 0]} name="Inflow" />
                    <Bar dataKey="outflow" fill="hsl(0, 84%, 60%)" radius={[4, 4, 0, 0]} name="Outflow" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Bottom Section: Transactions, Invoices, Bills */}
          <div className="grid gap-4 lg:grid-cols-3">
            {/* Recent Transactions */}
            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Recent Transactions</CardTitle>
                  <CardDescription>Your latest financial activity</CardDescription>
                </div>
                <Button variant="outline" size="sm">
                  View All
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Description</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentTransactions.map((txn) => (
                      <TableRow key={txn.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div
                              className={`h-2 w-2 rounded-full ${
                                txn.type === "income" ? "bg-green-500" : "bg-red-500"
                              }`}
                            />
                            <span className="font-medium">{txn.description}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{txn.category}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{txn.date}</TableCell>
                        <TableCell
                          className={`text-right font-medium ${
                            txn.type === "income" ? "text-green-600" : "text-red-600"
                          }`}
                        >
                          {txn.type === "income" ? "+" : "-"}${txn.amount.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Invoices & Bills */}
            <Card>
              <CardHeader>
                <Tabs defaultValue="invoices" className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="invoices">Invoices</TabsTrigger>
                    <TabsTrigger value="bills">Bills</TabsTrigger>
                  </TabsList>
                  <TabsContent value="invoices" className="mt-4 space-y-4">
                    <div className="text-sm text-muted-foreground mb-2">
                      Outstanding invoices requiring attention
                    </div>
                    {outstandingInvoices.map((invoice) => (
                      <div
                        key={invoice.id}
                        className="flex items-center justify-between p-3 rounded-lg border"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{invoice.customer}</span>
                            {invoice.status === "overdue" && (
                              <Badge variant="destructive" className="text-xs">
                                {invoice.daysOverdue}d overdue
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {invoice.id} • Due {invoice.dueDate}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">
                            ${invoice.amount.toLocaleString()}
                          </div>
                        </div>
                      </div>
                    ))}
                    <Button variant="outline" className="w-full" size="sm">
                      <Plus className="mr-2 h-4 w-4" />
                      Create Invoice
                    </Button>
                  </TabsContent>
                  <TabsContent value="bills" className="mt-4 space-y-4">
                    <div className="text-sm text-muted-foreground mb-2">
                      Upcoming bills to pay
                    </div>
                    {upcomingBills.map((bill) => (
                      <div
                        key={bill.id}
                        className="flex items-center justify-between p-3 rounded-lg border"
                      >
                        <div className="space-y-1">
                          <span className="font-medium text-sm">{bill.vendor}</span>
                          <div className="text-xs text-muted-foreground">
                            {bill.category} • Due {bill.dueDate}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">
                            ${bill.amount.toLocaleString()}
                          </div>
                        </div>
                      </div>
                    ))}
                    <Button variant="outline" className="w-full" size="sm">
                      <Plus className="mr-2 h-4 w-4" />
                      Add Bill
                    </Button>
                  </TabsContent>
                </Tabs>
              </CardHeader>
            </Card>
          </div>

          {/* Profit Margin Indicator */}
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Profit Margin</CardTitle>
              <CardDescription>Your current profit margin based on revenue and expenses</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Current Margin</span>
                  <span className="font-semibold text-green-600">38%</span>
                </div>
                <Progress value={38} className="h-2" />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>0%</span>
                  <span>Target: 35%</span>
                  <span>100%</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
