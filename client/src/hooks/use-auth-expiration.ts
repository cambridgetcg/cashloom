import { useEffect } from "react";
import { useAppDispatch, useTypedSelector } from "@/app/hook";
import { logout } from "@/features/auth/authSlice";

// Single long-lived token, no refresh endpoint: when it expires, log out.
const useAuthExpiration = () => {
  const { accessToken, expiresAt } = useTypedSelector((state) => state.auth);
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!accessToken || !expiresAt) return;

    const timeUntilExpiration = expiresAt - Date.now();

    if (timeUntilExpiration <= 0) {
      dispatch(logout());
      return;
    }

    const timer = setTimeout(() => dispatch(logout()), timeUntilExpiration);
    return () => clearTimeout(timer);
  }, [accessToken, expiresAt, dispatch]);
};

export default useAuthExpiration;