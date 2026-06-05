

export interface User {
    id: string;
    name: string;
    email: string;
    profilePicture: string;
    currency?: string;
}
export interface UpdateUserResponse {
    data: User
}
