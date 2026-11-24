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

    /// <summary>Ids (as strings) of participants who deleted the chat from their list.
    /// A new message brings it back. Older documents don't have the field: nobody hid them.</summary>
    public List<string> HiddenFor { get; init; } = [];
}