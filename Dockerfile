# syntax=docker/dockerfile:1

# Stage 1: compile the API
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY src/LostAndFound.Api/LostAndFound.Api.csproj src/LostAndFound.Api/
RUN dotnet restore src/LostAndFound.Api/LostAndFound.Api.csproj
COPY src/ src/
RUN dotnet publish src/LostAndFound.Api/LostAndFound.Api.csproj \
    -c Release -o /app/publish --no-restore

# Stage 2: generate the SQL that creates/updates the Postgres tables
FROM build AS migrations
RUN dotnet tool install --global dotnet-ef --version "10.*"
ENV PATH="${PATH}:/root/.dotnet/tools"
# Dummy values: EF runs the app's config code, which refuses to start without them. Nothing connects.
RUN mkdir -p /out && \
    ConnectionStrings__Postgres="Host=x;Database=x;Username=x;Password=x" \
    MongoDb__ConnectionString="mongodb://x" MongoDb__DatabaseName="x" \
    dotnet ef migrations script --idempotent \
      --project src/LostAndFound.Api/LostAndFound.Api.csproj \
      --output /out/migrations.sql

# Stage 3: the small final image that actually runs
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
COPY --from=migrations /out/migrations.sql /app/migrations.sql
USER $APP_UID
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "LostAndFound.Api.dll"]
