using LostAndFound.Api.Features.Chat.Messages;
using LostAndFound.Api.Features.Identity;
using LostAndFound.Api.Features.Items.Photos;
using LostAndFound.Api.Infrastructure.Persistence;
using LostAndFound.Api.Infrastructure.Storage;
using LostAndFound.Api.Features.Chat;
using LostAndFound.Api.Features.Chat.Live;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Identity.Web;
using MongoDB.Driver;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddHealthChecks();
builder.Services.AddOpenApi();
builder.Services.AddSingleton(TimeProvider.System);

// ---- Authentication (US-01) ----
// "Entra" (default): Microsoft Entra ID bearer tokens with the access_as_user scope.
// "Dev": X-Dev-User header, for running the app locally without a tenant. Development only.
var authMode = builder.Configuration["Auth:Mode"] ?? "Entra";
var useDevAuth = string.Equals(authMode, "Dev", StringComparison.OrdinalIgnoreCase);

if (useDevAuth && !builder.Environment.IsDevelopment())
{
    throw new InvalidOperationException("Auth:Mode=Dev is allowed only in the Development environment.");
}

if (useDevAuth)
{
    builder.Services
        .AddAuthentication(DevAuthenticationHandler.SchemeName)
        .AddScheme<AuthenticationSchemeOptions, DevAuthenticationHandler>(DevAuthenticationHandler.SchemeName, null);
    // [RequiredScope] still works: the dev handler issues the scp claim.
    builder.Services.AddRequiredScopeAuthorization();
}
else
{
    builder.Services
        .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
        .AddMicrosoftIdentityWebApi(builder.Configuration.GetSection("AzureAd"));
}

var allowedDomain = builder.Configuration["Auth:AllowedEmailDomain"];
builder.Services.AddAuthorization(options =>
{
    options.DefaultPolicy = new AuthorizationPolicyBuilder()
        .RequireAuthenticatedUser()
        .RequireAssertion(context => context.User.HasAllowedDomain(allowedDomain))
        .Build();
});

var connectionString = builder.Configuration.GetConnectionString("Postgres")
    ?? throw new InvalidOperationException("Connection string 'Postgres' is missing.");

builder.Services.AddDbContext<AppDbContext>(options => options.UseNpgsql(connectionString));
builder.Services.AddSingleton<IPhotoStorage, LocalPhotoStorage>();

var mongoConnectionString = builder.Configuration["MongoDb:ConnectionString"];
var mongoDatabaseName = builder.Configuration["MongoDb:DatabaseName"];

if (string.IsNullOrWhiteSpace(mongoConnectionString))
{
    throw new InvalidOperationException("MongoDb:ConnectionString is missing.");
}

if (string.IsNullOrWhiteSpace(mongoDatabaseName))
{
    throw new InvalidOperationException("MongoDb:DatabaseName is missing.");
}

builder.Services.AddSingleton<IMongoClient>(_ => new MongoClient(mongoConnectionString));
builder.Services.AddSingleton<IMongoDatabase>(services =>
    services.GetRequiredService<IMongoClient>().GetDatabase(mongoDatabaseName));
builder.Services.AddSingleton<ChatDbContext>();
builder.Services.AddScoped<ChatMessageService>();
builder.Services.AddSingleton<ChatEvents>();
builder.Services.AddSingleton<ChatTickets>();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();

    // Local runs: create/upgrade the Postgres schema on start, so `dotnet run` is enough.
    // Production applies migrations.sql from the Docker image instead.
    if (app.Configuration.GetValue("Database:MigrateOnStartup", true))
    {
        using var scope = app.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync();
    }
}

await ChatIndexes.EnsureCreatedAsync(app.Services.GetRequiredService<ChatDbContext>());

app.UseHttpsRedirection();

app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(30)
});

app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();
app.MapHealthChecks("/health");
app.Run();

/// <summary>Visible to integration tests (WebApplicationFactory).</summary>
public partial class Program;
