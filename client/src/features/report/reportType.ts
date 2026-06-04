

export interface ReportTopCategory {
    name: string;
    amount: number;
    percent: number;
}

export interface ReportSummary {
    income: number;
    expenses: number;
    balance: number;
    savingsRate: number;
    topCategories: ReportTopCategory[];
}

export interface ReportType {
    _id: string;
    userId: string;
    period: string;
    sentDate: string;
    status: string;
    summary?: ReportSummary;
    insights?: string[];
    createdAt: string;
    updatedAt: string;
    __v: number;
}

export interface GetAllReportResponse {
    message: string;
    reports: ReportType[];
    pagination: {
        pageSize: number;
        pageNumber: number;
        totalCount: number;
        totalPages: number;
        skip: number;
    }
}


export interface UpdateReportSettingParams {
    isEnabled: boolean;
}