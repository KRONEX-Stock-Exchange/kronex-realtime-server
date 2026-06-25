export default () => ({
    DATABASE_URL: process.env.DATABASE_URL,
    ACCESS_TOKEN_SECRET: process.env.ACCESS_TOKEN_SECRET,
    RABBITMQ_URL: process.env.RABBITMQ_URL,
    REALTIME_SERVER_PORT: Number(process.env.REALTIME_SERVER_PORT),
});
