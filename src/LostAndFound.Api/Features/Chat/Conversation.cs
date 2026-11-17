using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace LostAndFound.Api.Features.Chat;

public sealed class Conversation
{
    [BsonId]
    [BsonGuidRepresentation(GuidRepresentation.Standard)]
    public Guid Id { get; init; } = Guid.NewGuid();

    [BsonGuidRepresentation(GuidRepresentation.Standard)]
    public Guid FoundItemId { get; init; }

    [BsonGuidRepresentation(GuidRepresentation.Standard)]
    public Guid OwnerUserId { get; init; }

    [BsonGuidRepresentation(GuidRepresentation.Standard)]
    public Guid InitiatorUserId { get; init; }
    
    public string OwnerName { get; init; } = "Student";

    public string InitiatorName { get; init; } = "Student";

    [BsonDateTimeOptions(Kind = DateTimeKind.Utc)]
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;
}