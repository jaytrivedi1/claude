import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { queryClient } from '@/lib/queryClient';

interface Company {
  id: number;
  name: string;
  [key: string]: any;
}

interface User {
  id: number;
  username: string;
  email: string | null;
  role: string;
  isActive: boolean;
  firstName: string | null;
  lastName: string | null;
}

interface AuthContextType {
  user: User | null;
  companies: Company[];
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>;
  register: (username: string, password: string, email?: string, firstName?: string, lastName?: string) => Promise<void>;
  logout: () => Promise<void>;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      // Check localStorage for saved session
      const savedUser = localStorage.getItem('vedo_user');
      const savedCompanies = localStorage.getItem('vedo_companies');

      if (savedUser) {
        setUser(JSON.parse(savedUser));
        if (savedCompanies) {
          setCompanies(JSON.parse(savedCompanies));
        }
      }
    } catch (error) {
      console.error('Auth check failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (username: string, password: string, rememberMe: boolean = false) => {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, rememberMe }),
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Login failed');
    }

    const data = await response.json();
    const { companies: userCompanies, ...userData } = data;

    // Store in state
    setUser(userData);
    setCompanies(userCompanies || []);

    // Persist to localStorage
    localStorage.setItem('vedo_user', JSON.stringify(userData));
    localStorage.setItem('vedo_companies', JSON.stringify(userCompanies || []));
  };

  const register = async (
    username: string,
    password: string,
    email?: string,
    firstName?: string,
    lastName?: string
  ) => {
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email, firstName, lastName }),
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Registration failed');
    }

    const userData = await response.json();
    setUser(userData);
  };

  const logout = async () => {
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'include',
    });
    // Clear all cached data to ensure fresh state for next user
    queryClient.clear();
    localStorage.removeItem('vedo_user');
    localStorage.removeItem('vedo_companies');
    setUser(null);
    setCompanies([]);
  };

  return (
    <AuthContext.Provider value={{ user, companies, login, register, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
