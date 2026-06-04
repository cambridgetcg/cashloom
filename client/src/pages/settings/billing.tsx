import { Separator } from "@/components/ui/separator";
import { Link } from "react-router-dom";

const Billing = () => {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Billing</h3>
        <p className="text-sm text-muted-foreground">
          Manage your subscription and billing information
        </p>
      </div>
      <Separator />

      <div className="w-full">
        {/* Current Plan */}
        {/* Upgrade Options */}
        <div className="mt-0">
          <h1 className="text-lg font-medium mb-2">Support Us</h1>
          <p className="text-base mb-2">
            The Billing feature is part of the <strong>extended version</strong>{" "}
            of this project. It took <strong>weeks and months</strong> to
            design, build, and refine.
          </p>

          <p className="text-base mb-2">
            By supporting us, you’ll unlock premium billing features including:
          </p>

          <ul className="list-disc pl-5 text-base mb-2">
            <li>
              <strong>Monthly & Yearly Plans</strong> built-in
            </li>
            <li>
              <strong>Switch between plans</strong> (monthly ↔ yearly)
            </li>
            <li>
              <strong>Manage & Cancel Subscriptions</strong> anytime
            </li>
          </ul>

          <p className="text-base font-medium">
            🔓 <span className="text-green-600">Get it here:</span>
            <Link
              to="/not-found"
              className="text-blue-500 underline ml-1"
              rel="noopener noreferrer"
            >
              Click Here
            </Link>
          </p>
          <br />
          <br />
        </div>
      </div>
    </div>
  );
};

export default Billing;
