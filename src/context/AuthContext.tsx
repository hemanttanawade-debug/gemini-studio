import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { googleLogout } from "@react-oauth/google";
import { buildApiUrl } from "@/lib/backend";
import { handleMockApi, isMockBackendActive } from "@/lib/mockBackend";

interface User {
  email: string;
  name: string;
  picture: string;
  idToken: string;
  expiresAt: number;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  handleGoogleSuccess: (idToken: string) => Promise<void>;
  loginDemo: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);
const STORAGE_KEY = "gws_user";

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed: User = JSON.parse(stored);
        if (parsed.expiresAt > Date.now()) {
          setUser(parsed);
        } else {
          sessionStorage.removeItem(STORAGE_KEY);
        }
      }
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
    setIsLoading(false);
  }, []);

  const handleGoogleSuccess = useCallback(async (idToken: string) => {
    const reqInit: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: idToken }),
    };

    const res = isMockBackendActive()
      ? await handleMockApi("/api/auth/verify", reqInit)
      : await fetch(buildApiUrl("/api/auth/verify"), reqInit);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).error || "Access denied");
    }

    const data = await res.json();

    const newUser: User = {
      email: data.email,
      name: data.name || "",
      picture: data.picture || "",
      idToken,
      expiresAt: Date.now() + 59 * 60 * 1000,
    };

    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(newUser));
    setUser(newUser);
  }, []);

  const loginDemo = useCallback(async () => {
    await handleGoogleSuccess("demo-session-token");
  }, [handleGoogleSuccess]);

  const logout = useCallback(() => {
    googleLogout();
    sessionStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, handleGoogleSuccess, loginDemo, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};