import { PROTECTED_ROUTES } from "@/routes/common/routePath"
import LogoDark from "../../assets/images/Logo.png"
import { Link } from "react-router-dom"

const Logo = (props: { url?: string }) => {
  return (
    <Link to={props.url || PROTECTED_ROUTES.OVERVIEW} className="flex items-center gap-2">
    <div className="text-white rounded w-8 h-8 border border-[#00C951] flex items-center justify-center">
        <img className="rounded w-full h-full" src={LogoDark} />
    </div>
    <span className="font-semibold text-lg">Cashloom</span>
  </Link>
  )
}

export default Logo