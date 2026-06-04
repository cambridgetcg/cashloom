import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';

const NotFound = () => {
    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
            <div className="max-w-2xl w-full text-center">
                {/* Main Error Icon */}
                <div className="mb-8">
                    <div className="inline-flex items-center justify-center w-24 h-24 bg-red-100 rounded-full mb-6">
                        <AlertTriangle className="w-12 h-12 text-red-500" />
                    </div>
                </div>

                {/* Large 404 Number */}
                <div className="mb-6">
                    <h1 className="text-8xl md:text-9xl font-bold text-gray-800 leading-none">
                        404
                    </h1>
                </div>

                {/* Error Message */}
                <div className="mb-8">
                    <h2 className="text-2xl md:text-3xl font-semibold text-gray-700 mb-4">
                        Oops!!!
                    </h2>
                    <p className="text-lg md:text-xl text-gray-600 leading-relaxed">
                        we are working on this site 404 not found
                    </p>
                </div>

                {/* Action Buttons */}
                <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
                    <button>
                        <Link className="inline-flex items-center px-6 py-3 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 transition-colors duration-200 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5" to={"/"}>
                        <Home className="w-5 h-5 mr-2" />
                        Go Home
                        </Link>
                    </button>

                    <button className="inline-flex items-center px-6 py-3 bg-gray-100 text-gray-700 font-medium rounded-lg hover:bg-gray-200 transition-colors duration-200 border border-gray-300">
                        <RefreshCw className="w-5 h-5 mr-2" />
                        Try Again
                    </button>
                </div>

                {/* Decorative Elements */}
                <div className="mt-12 opacity-50">
                    <div className="flex justify-center space-x-2">
                        <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce"></div>
                        <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                        <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                    </div>
                    <p className="text-sm text-gray-500 mt-4">
                        We're working hard to get things back up and running
                    </p>
                </div>
            </div>
        </div>
    )
}

export default NotFound